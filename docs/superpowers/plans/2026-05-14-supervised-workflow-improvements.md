# Supervised Workflow Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add agent-driven clarification loop + architectural summary posting to the supervised workflow, and add complexity-based workflow routing to the issue analyzer.

**Architecture:** Two independent changes: (1) the supervised YAML workflow gains pre-planning Q&A nodes (agent decides when to stop) and post-planning summary nodes that post to Linear; (2) the issue analyzer prompt gains a complexity rubric and the parse logic overrides workflow selection based on it. The canonical template lives in `src/cli/templates-default.ts`; three trialmatch copies must be kept in sync manually.

**Tech Stack:** TypeScript/Bun (analyzer), YAML (Archon workflow), Linear GraphQL API (comment posting), `curl` + `python3` (bash nodes in workflows)

---

## File Map

| File | Change |
|---|---|
| `src/domain/types.ts` | Add `complexity` field to `IssueAnalysis` |
| `src/analyzer/issue-analyzer.ts` | Update `buildPrompt` + `analyze()` parse logic |
| `src/__tests__/analyzer.test.ts` | Add complexity routing tests |
| `src/cli/templates-default.ts` | Update `SUPERVISED` const — clarification + summary nodes |
| `C:/Repos/trialmatch/workflow_templates/gaggle-supervised.yaml` | Sync from updated template |
| `C:/Repos/trialmatch/repos/TrialMatch-FE/.archon/workflows/gaggle/gaggle-supervised.yaml` | Sync from updated template |
| `C:/Repos/trialmatch/repos/TrialMatch-BE/.archon/workflows/gaggle/gaggle-supervised.yaml` | Sync from updated template |

---

## Task 1: Add `complexity` to `IssueAnalysis` type

**Files:**
- Modify: `src/domain/types.ts`

- [ ] **Step 1: Add the field**

In `src/domain/types.ts`, find the `IssueAnalysis` interface (currently lines 270–274) and add the `complexity` field:

```typescript
export interface IssueAnalysis {
  issue_id: string;
  analysis_summary: string;
  repo_targets: RepoTarget[];
  complexity?: 'simple' | 'complex';
}
```

- [ ] **Step 2: Commit**

```bash
git add src/domain/types.ts
git commit -m "feat: add complexity field to IssueAnalysis type"
```

---

## Task 2: Update `buildPrompt` with complexity rubric and workflow-selection rules

**Files:**
- Modify: `src/analyzer/issue-analyzer.ts` (the `buildPrompt` function at the bottom of the file)

- [ ] **Step 1: Write a failing test that asserts complexity appears in the prompt**

In `src/__tests__/analyzer.test.ts`, add at the top of the `describe` block:

```typescript
test('buildPrompt includes complexity rubric text', async () => {
  // We test this indirectly: a "simple" response sets complexity=simple and
  // routes to gaggle-fix-issue even when the runner says gaggle-supervised.
  const ctx = makeRegistryContext([
    makeRegistryRepo({
      name: 'repo-a',
      url: 'https://github.com/o/repo-a',
      available_workflows: ['gaggle/gaggle-fix-issue', 'gaggle/gaggle-supervised'],
      default_workflow: 'gaggle/gaggle-supervised',
    }),
  ]);
  const json = JSON.stringify({
    analysis_summary: 'trivial fix',
    complexity: 'simple',
    repo_targets: [{ repo_url: 'https://github.com/o/repo-a', repo_alias: 'repo-a', rationale: '', components: [] }],
  });
  const a = new IssueAnalyzer(makeServiceConfig(), fakeRunner(json));
  const r = await a.analyze(makeIssue(), ctx);
  expect(r.repo_targets[0]!.archon_workflow).toBe('gaggle/gaggle-fix-issue');
  expect(r.complexity).toBe('simple');
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd C:/Repos/GaggleDispatch && bun test src/__tests__/analyzer.test.ts 2>&1 | tail -20
```

Expected: test fails (complexity field not parsed yet).

- [ ] **Step 3: Replace the `buildPrompt` function**

Find `function buildPrompt` in `src/analyzer/issue-analyzer.ts` (line ~241). Replace the entire function:

```typescript
function buildPrompt(issue: Issue, ctx: RegistryContext): string {
  const repoList = ctx.repositories
    .map((r) => `- ${r.name}  (url: ${r.url}, local checkout: ${r.local_path})`)
    .join('\n');

  const blockerLines =
    issue.blocked_by.length > 0
      ? issue.blocked_by.map((b) => `- ${b.identifier ?? b.id} [${b.state ?? '?'}]`).join('\n')
      : '(none)';

  return `You are GaggleDispatch's Issue Analyzer. Your job is to decide which repositories need changes to resolve the issue below, assess complexity, and produce a JSON routing decision.

## Registered repositories

${repoList}

For each repo a local checkout is available at the path shown. Read its \`gaggle.md\` (at the repo root) to understand what it owns and what it communicates with. You may also read other files (package.json, directory layout, key source files) if the issue is ambiguous.

## Issue

Identifier : ${issue.identifier}
Title      : ${issue.title}
State      : ${issue.state}
Priority   : ${issue.priority ?? 'none'}
Labels     : ${issue.labels.join(', ') || '(none)'}
URL        : ${issue.url ?? ''}
Blockers:
${blockerLines}

Description:
${issue.description ?? '(no description)'}

## Instructions

1. Read the \`gaggle.md\` of each relevant repo (and any other files that help).
2. Decide which repos need changes. Err on the side of FEWER, higher-confidence targets.
3. Assess complexity using the rubric below.
4. Output ONLY the following JSON — no prose, no markdown fences:

{
  "analysis_summary": "Short paragraph (2-4 sentences) explaining which services/components are affected and why.",
  "complexity": "<simple|complex — see rubric below>",
  "repo_targets": [
    {
      "repo_url": "<exact url from the repo list above>",
      "repo_alias": "<name field from that repo's gaggle.md>",
      "rationale": "One sentence on why this repo is included.",
      "components": ["component-name-from-gaggle-md"],
      "depends_on": ["alias-of-upstream-repo-if-this-one-depends-on-it"],
      "ready_when": "merged"
    }
  ]
}

## Complexity rubric

**simple** — ALL of the following must be true:
- Touches a single component in a single repo
- No new UX flows, screens, or interaction patterns
- No architectural decisions (state shape, API contracts, auth, shared infrastructure)
- Clear, fully-specified scope with no ambiguous requirements
- No cross-repo dependencies introduced
Examples: fix a typo, update a config value, add a null check, adjust a label or style.

**complex** — ANY of the following is true:
- Spans multiple components or repos
- Introduces new UX flows, screens, or interaction patterns
- Requires architectural decisions (state shape, API contracts, auth, shared infrastructure)
- Has ambiguous or underspecified requirements a human should validate before implementation
- Introduces new cross-repo dependencies
Examples: new feature page, API shape change, auth flow update, multi-service change.

## Workflow assignment

The \`archon_workflow\` field in EACH repo_target MUST be determined by complexity, not by the repo's default:
- complexity == "simple"  → archon_workflow = "gaggle/gaggle-fix-issue"
- complexity == "complex" → archon_workflow = "gaggle/gaggle-supervised"

Then verify that workflow is listed in that repo's \`available_workflows\` in gaggle.md.
If it is NOT listed, use the repo's \`default_workflow\` instead and note it in the rationale.

Rules:
- repo_alias must match the \`name\` field in that repo's gaggle.md front matter exactly.
- components must be names from that repo's gaggle.md \`components\` list.
- For depends_on + ready_when: use "merged" when this repo's changes depend on another repo's PR being merged first. Omit depends_on when repos can be worked on in parallel.
- Output JSON only.`;
}
```

- [ ] **Step 4: Run the test to confirm it still fails (complexity not parsed yet)**

```bash
bun test src/__tests__/analyzer.test.ts 2>&1 | tail -20
```

Expected: same failure — parse logic not updated yet.

---

## Task 3: Parse `complexity` and override workflow in `analyze()`

**Files:**
- Modify: `src/analyzer/issue-analyzer.ts` (the `analyze` method)

- [ ] **Step 1: Add complexity parsing and workflow override**

In `IssueAnalyzer.analyze()`, after the line `let parsed: { analysis_summary?: unknown; repo_targets?: unknown };` (around line 79), expand the type annotation and add complexity parsing. Replace the section from the `let parsed` declaration through the `const analysis_summary` line:

```typescript
let parsed: { analysis_summary?: unknown; repo_targets?: unknown; complexity?: unknown };
try {
  parsed = JSON.parse(json);
} catch (err) {
  throw new IssueAnalysisError(`Claude JSON failed to parse: ${(err as Error).message}`, err);
}

const rawComplexity = parsed.complexity;
const complexity: 'simple' | 'complex' =
  rawComplexity === 'simple' ? 'simple' : 'complex';

const complexityWorkflow =
  complexity === 'simple' ? 'gaggle/gaggle-fix-issue' : 'gaggle/gaggle-supervised';

const analysis_summary =
  `[complexity: ${complexity}] ` +
  (typeof parsed.analysis_summary === 'string' ? parsed.analysis_summary : '');
```

- [ ] **Step 2: Replace the per-target `archon_workflow` resolution**

Find the `archonWf` assignment inside the `for (const t of targetsRaw)` loop (around line 114):

```typescript
      const archonWf =
        typeof obj.archon_workflow === 'string' && obj.archon_workflow
          ? obj.archon_workflow
          : matched.default_workflow || this.cfg.archon.default_workflow;
```

Replace it with:

```typescript
      let archonWf: string;
      if (matched.available_workflows.includes(complexityWorkflow)) {
        archonWf = complexityWorkflow;
      } else {
        logger.warn('Complexity-derived workflow not in available_workflows — falling back to repo default', {
          issue_id: issue.id,
          repo: matched.name,
          desired: complexityWorkflow,
          fallback: matched.default_workflow || this.cfg.archon.default_workflow,
        });
        archonWf = matched.default_workflow || this.cfg.archon.default_workflow;
      }
```

- [ ] **Step 3: Expose `complexity` on the returned `IssueAnalysis`**

Find the `return` statement at the end of `analyze()`:

```typescript
    return { issue_id: issue.id, analysis_summary, repo_targets };
```

Replace with:

```typescript
    return { issue_id: issue.id, analysis_summary, repo_targets, complexity };
```

- [ ] **Step 4: Run the failing test to verify it now passes**

```bash
bun test src/__tests__/analyzer.test.ts 2>&1 | tail -20
```

Expected: the new test passes.

- [ ] **Step 5: Run the full analyzer test suite to check for regressions**

```bash
bun test src/__tests__/analyzer.test.ts 2>&1
```

Expected: ALL tests pass. If any existing test fails because it asserts `archon_workflow` and now complexity overrides it, update that test's fixture to include appropriate `available_workflows` (see Step 6).

- [ ] **Step 6: Fix regressions if any — update fixtures**

The existing test at line 21 (`parses a clean JSON response`) will now fail because `complexity` defaults to `'complex'` when absent, routing to `gaggle/gaggle-supervised` — which is what it already expected. But the test at line 41 checks `archon_workflow` is `'gaggle/gaggle-supervised'`. Since `complexity` is absent from the JSON, it defaults to `'complex'`, which maps to `gaggle/gaggle-supervised`. That repo has `available_workflows: ['gaggle/gaggle-supervised']` by default from `makeRegistryRepo` — confirm by checking `src/__tests__/helpers/fixtures.ts`.

Check what `makeRegistryRepo` defaults `available_workflows` to:

```bash
grep -A 20 "makeRegistryRepo" src/__tests__/helpers/fixtures.ts
```

If `available_workflows` defaults to `['gaggle/gaggle-fix-issue', 'gaggle/gaggle-supervised']` or similar, existing tests should pass. If it defaults to `[]`, the fallback path triggers — update tests that assert specific workflow values to include the needed workflow in `available_workflows`.

- [ ] **Step 7: Commit**

```bash
git add src/analyzer/issue-analyzer.ts
git commit -m "feat: complexity-based workflow routing in issue analyzer"
```

---

## Task 4: Add comprehensive complexity routing tests

**Files:**
- Modify: `src/__tests__/analyzer.test.ts`

- [ ] **Step 1: Add the test cases**

Add a new `describe` block after the existing one in `src/__tests__/analyzer.test.ts`:

```typescript
describe('IssueAnalyzer complexity routing', () => {
  test('simple complexity routes to gaggle-fix-issue, overriding repo default_workflow', async () => {
    const ctx = makeRegistryContext([
      makeRegistryRepo({
        name: 'repo-a',
        url: 'https://github.com/o/repo-a',
        available_workflows: ['gaggle/gaggle-fix-issue', 'gaggle/gaggle-supervised'],
        default_workflow: 'gaggle/gaggle-supervised',
      }),
    ]);
    const json = JSON.stringify({
      analysis_summary: 'trivial one-liner fix',
      complexity: 'simple',
      repo_targets: [{ repo_alias: 'repo-a', rationale: '', components: [] }],
    });
    const r = await new IssueAnalyzer(makeServiceConfig(), fakeRunner(json)).analyze(makeIssue(), ctx);
    expect(r.complexity).toBe('simple');
    expect(r.repo_targets[0]!.archon_workflow).toBe('gaggle/gaggle-fix-issue');
    expect(r.analysis_summary).toContain('[complexity: simple]');
  });

  test('complex complexity routes to gaggle-supervised, overriding repo default_workflow', async () => {
    const ctx = makeRegistryContext([
      makeRegistryRepo({
        name: 'repo-a',
        url: 'https://github.com/o/repo-a',
        available_workflows: ['gaggle/gaggle-fix-issue', 'gaggle/gaggle-supervised'],
        default_workflow: 'gaggle/gaggle-fix-issue',
      }),
    ]);
    const json = JSON.stringify({
      analysis_summary: 'new feature spanning multiple components',
      complexity: 'complex',
      repo_targets: [{ repo_alias: 'repo-a', rationale: '', components: [] }],
    });
    const r = await new IssueAnalyzer(makeServiceConfig(), fakeRunner(json)).analyze(makeIssue(), ctx);
    expect(r.complexity).toBe('complex');
    expect(r.repo_targets[0]!.archon_workflow).toBe('gaggle/gaggle-supervised');
    expect(r.analysis_summary).toContain('[complexity: complex]');
  });

  test('missing complexity field defaults to complex', async () => {
    const ctx = makeRegistryContext([
      makeRegistryRepo({
        name: 'repo-a',
        url: 'https://github.com/o/repo-a',
        available_workflows: ['gaggle/gaggle-fix-issue', 'gaggle/gaggle-supervised'],
        default_workflow: 'gaggle/gaggle-fix-issue',
      }),
    ]);
    const json = JSON.stringify({
      analysis_summary: 'something',
      // no complexity field
      repo_targets: [{ repo_alias: 'repo-a', rationale: '', components: [] }],
    });
    const r = await new IssueAnalyzer(makeServiceConfig(), fakeRunner(json)).analyze(makeIssue(), ctx);
    expect(r.complexity).toBe('complex');
    expect(r.repo_targets[0]!.archon_workflow).toBe('gaggle/gaggle-supervised');
  });

  test('falls back to repo default_workflow when complexity-derived workflow not in available_workflows', async () => {
    const ctx = makeRegistryContext([
      makeRegistryRepo({
        name: 'repo-a',
        url: 'https://github.com/o/repo-a',
        available_workflows: ['gaggle/gaggle-supervised'],   // fix-issue NOT available
        default_workflow: 'gaggle/gaggle-supervised',
      }),
    ]);
    const json = JSON.stringify({
      analysis_summary: 'simple fix',
      complexity: 'simple',
      repo_targets: [{ repo_alias: 'repo-a', rationale: '', components: [] }],
    });
    const r = await new IssueAnalyzer(makeServiceConfig(), fakeRunner(json)).analyze(makeIssue(), ctx);
    // gaggle-fix-issue not available → fallback to default_workflow
    expect(r.repo_targets[0]!.archon_workflow).toBe('gaggle/gaggle-supervised');
  });

  test('complexity routing applied consistently across all repo_targets in a multi-repo result', async () => {
    const ctx = makeRegistryContext([
      makeRegistryRepo({
        name: 'frontend',
        url: 'https://github.com/o/frontend',
        available_workflows: ['gaggle/gaggle-fix-issue', 'gaggle/gaggle-supervised'],
        default_workflow: 'gaggle/gaggle-supervised',
      }),
      makeRegistryRepo({
        name: 'backend',
        url: 'https://github.com/o/backend',
        available_workflows: ['gaggle/gaggle-fix-issue', 'gaggle/gaggle-supervised'],
        default_workflow: 'gaggle/gaggle-supervised',
      }),
    ]);
    const json = JSON.stringify({
      analysis_summary: 'multi-repo feature',
      complexity: 'complex',
      repo_targets: [
        { repo_alias: 'frontend', rationale: '', components: [] },
        { repo_alias: 'backend', rationale: '', components: [] },
      ],
    });
    const r = await new IssueAnalyzer(makeServiceConfig(), fakeRunner(json)).analyze(makeIssue(), ctx);
    expect(r.repo_targets[0]!.archon_workflow).toBe('gaggle/gaggle-supervised');
    expect(r.repo_targets[1]!.archon_workflow).toBe('gaggle/gaggle-supervised');
  });
});
```

- [ ] **Step 2: Run the new tests**

```bash
bun test src/__tests__/analyzer.test.ts 2>&1
```

Expected: all tests (old + new) pass.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/analyzer.test.ts
git commit -m "test: complexity routing coverage for IssueAnalyzer"
```

---

## Task 5: Update the supervised template — clarification phase

**Files:**
- Modify: `src/cli/templates-default.ts` (the `SUPERVISED` const)

This task inserts the 7-node clarification chain into the SUPERVISED YAML and updates `investigate`/`plan` to depend on it and read `answers.md`.

- [ ] **Step 1: Find the insertion point**

In `src/cli/templates-default.ts`, find the `SUPERVISED` const. Inside it, locate the section comment and `investigate` node that begins:

```
  # ═══════════════════════════════════════════════════════════════
  # PHASE 2: RESEARCH
  # ═══════════════════════════════════════════════════════════════

  - id: investigate
    depends_on: [classify]
    when: "$classify.output.issue_type == 'bug'"
```

- [ ] **Step 2: Insert the clarification phase BEFORE Phase 2**

Insert the following block between the end of Phase 1 (`classify` node's `output_format` closes) and the start of Phase 2 (the RESEARCH section comment):

```yaml
  # ═══════════════════════════════════════════════════════════════
  # PHASE 2.5: CLARIFICATION
  # Agent-driven Q&A. Human only answers — the agent decides
  # whether another round is needed. Maximum 2 rounds.
  # ═══════════════════════════════════════════════════════════════

  - id: clarify
    depends_on: [classify]
    model: haiku
    allowed_tools: []
    context: fresh
    prompt: |
      You are preparing to plan the implementation of the issue below.
      Before planning begins, identify any ambiguous or underspecified requirements
      that would materially change the implementation approach.

      ## Issue context

      \$USER_MESSAGE

      ## Instructions

      If genuine open questions exist (not answerable by reading the codebase):
      - Write them as a numbered list to \$ARTIFACTS_DIR/questions.md
      - Be specific and concrete — do not ask open-ended "tell me more" questions

      If the issue is fully specified and nothing is unclear:
      - Write exactly the word NONE to \$ARTIFACTS_DIR/questions.md

      Do NOT ask about things that can be inferred by reading the source files.
      Do NOT ask about implementation details — only about requirements and intent.

  - id: clarify-needed
    bash: |
      set -euo pipefail
      mkdir -p "\$ARTIFACTS_DIR"
      if [ ! -f "\$ARTIFACTS_DIR/questions.md" ]; then
        echo "NO"
        exit 0
      fi
      TRIMMED=$(tr -d '[:space:]' < "\$ARTIFACTS_DIR/questions.md")
      if [ "\$TRIMMED" = "NONE" ]; then echo "NO"; else echo "YES"; fi
    depends_on: [clarify]

  - id: clarify-post-round-1
    bash: |
      set -euo pipefail
      BODY=$(cat "\$ARTIFACTS_DIR/questions.md")
      ESCAPED=$(printf '%s' "\$BODY" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
      curl -sf -X POST https://api.linear.app/graphql \\
        -H "Authorization: \$LINEAR_API_KEY" \\
        -H "Content-Type: application/json" \\
        --data "{\"query\": \"mutation { commentCreate(input: { issueId: \\\\\"\$GAGGLE_ISSUE_ID\\\\\", body: \$ESCAPED }) { success } }\"}" \\
        || echo "WARNING: failed to post clarifying questions to Linear" >&2
      printf '## Round 1 Questions\\n\\n' > "\$ARTIFACTS_DIR/answers.md"
      cat "\$ARTIFACTS_DIR/questions.md" >> "\$ARTIFACTS_DIR/answers.md"
      printf '\\n## Round 1 Answers\\n\\n' >> "\$ARTIFACTS_DIR/answers.md"
    depends_on: [clarify-needed]
    when: "$clarify-needed.output == 'YES'"

  - id: clarify-gate-round-1
    depends_on: [clarify-post-round-1]
    when: "$clarify-needed.output == 'YES'"
    approval:
      message: |
        ## Clarifying Questions

        \$(cat "\$ARTIFACTS_DIR/questions.md")

        Please answer these questions. Your responses will shape the implementation plan.
      capture_response: true

  - id: clarify-evaluate-round-1
    depends_on: [clarify-gate-round-1]
    when: "$clarify-needed.output == 'YES'"
    model: haiku
    allowed_tools: []
    context: fresh
    prompt: |
      Review whether the human's answers are sufficient to proceed to planning.

      ## Original questions

      Read \$ARTIFACTS_DIR/questions.md

      ## Human's answers

      \$clarify-gate-round-1.output

      ## Instructions

      1. Append the human's answers to \$ARTIFACTS_DIR/answers.md after the
         "## Round 1 Answers" header already in the file.
      2. Determine if all critical questions are answered.
      3. If sufficient: output {"complete": "true", "followup_questions": ""}
      4. If critical gaps remain: write ONLY the new follow-up questions (numbered list)
         to \$ARTIFACTS_DIR/questions.md (overwrite), then populate followup_questions.
    output_format:
      type: object
      properties:
        complete:
          type: string
          enum: ["true", "false"]
        followup_questions:
          type: string
      required: [complete, followup_questions]

  - id: clarify-post-round-2
    bash: |
      set -euo pipefail
      BODY=$(cat "\$ARTIFACTS_DIR/questions.md")
      ESCAPED=$(printf '%s' "\$BODY" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
      curl -sf -X POST https://api.linear.app/graphql \\
        -H "Authorization: \$LINEAR_API_KEY" \\
        -H "Content-Type: application/json" \\
        --data "{\"query\": \"mutation { commentCreate(input: { issueId: \\\\\"\$GAGGLE_ISSUE_ID\\\\\", body: \$ESCAPED }) { success } }\"}" \\
        || echo "WARNING: failed to post round-2 questions to Linear" >&2
      printf '\\n## Round 2 Questions\\n\\n' >> "\$ARTIFACTS_DIR/answers.md"
      cat "\$ARTIFACTS_DIR/questions.md" >> "\$ARTIFACTS_DIR/answers.md"
      printf '\\n## Round 2 Answers\\n\\n' >> "\$ARTIFACTS_DIR/answers.md"
    depends_on: [clarify-evaluate-round-1]
    when: "$clarify-evaluate-round-1.output.complete == 'false'"

  - id: clarify-gate-round-2
    depends_on: [clarify-post-round-2]
    when: "$clarify-evaluate-round-1.output.complete == 'false'"
    approval:
      message: |
        ## Follow-up Questions

        \$(cat "\$ARTIFACTS_DIR/questions.md")

        Please answer these follow-up questions.
      capture_response: true

  - id: clarify-append-round-2
    bash: |
      set -euo pipefail
      # Append round-2 answers to answers.md so investigate/plan can read them
      printf '%s\n' "\$clarify-gate-round-2.output" >> "\$ARTIFACTS_DIR/answers.md"
    depends_on: [clarify-gate-round-2]
    when: "$clarify-evaluate-round-1.output.complete == 'false'"

  - id: clarify-merge
    bash: |
      if [ -f "\$ARTIFACTS_DIR/answers.md" ]; then
        echo "Clarification complete — answers gathered"
      else
        echo "Clarification complete — no questions needed"
      fi
    depends_on: [clarify-needed, clarify-evaluate-round-1, clarify-append-round-2]
    trigger_rule: one_success

```

In the TypeScript string, this must be placed inside the backtick-delimited `SUPERVISED` const. Every `$` that is a bash or Archon variable reference is written as `\$` (as shown above). The `when` conditions that reference node outputs (`$clarify-needed.output`) use plain `$` — they are not interpolated by TypeScript because they lack `{`.

- [ ] **Step 3: Update the `investigate` node**

Find the `investigate` node in the SUPERVISED const. Change its `depends_on` and add answers context:

**Before:**
```
  - id: investigate
    depends_on: [classify]
    when: "$classify.output.issue_type == 'bug'"
    context: fresh
    prompt: |
      You are investigating a bug. Fully understand the root cause before any fix is attempted.

      ## Issue context

      \$USER_MESSAGE

      ## Instructions
```

**After:**
```
  - id: investigate
    depends_on: [clarify-merge]
    when: "$classify.output.issue_type == 'bug'"
    context: fresh
    prompt: |
      You are investigating a bug. Fully understand the root cause before any fix is attempted.

      ## Issue context

      \$USER_MESSAGE

      ## Clarification answers (if any)

      If \$ARTIFACTS_DIR/answers.md exists, read it before investigating — it contains
      human-provided context that may affect the scope of the fix.

      ## Instructions
```

- [ ] **Step 4: Update the `plan` node**

Find the `plan` node. Change its `depends_on` and add answers context:

**Before:**
```
  - id: plan
    depends_on: [classify]
    when: "$classify.output.issue_type != 'bug'"
    context: fresh
    prompt: |
      You are planning an implementation. Produce a plan detailed enough for a separate
      agent to execute without ambiguity.

      ## Issue context

      \$USER_MESSAGE

      ## Instructions
```

**After:**
```
  - id: plan
    depends_on: [clarify-merge]
    when: "$classify.output.issue_type != 'bug'"
    context: fresh
    prompt: |
      You are planning an implementation. Produce a plan detailed enough for a separate
      agent to execute without ambiguity.

      ## Issue context

      \$USER_MESSAGE

      ## Clarification answers (if any)

      If \$ARTIFACTS_DIR/answers.md exists, read it before planning — it contains
      human-provided context that must shape the implementation plan.

      ## Instructions
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/templates-default.ts
git commit -m "feat: add agent-driven clarification loop to supervised workflow template"
```

---

## Task 6: Update supervised template — summarize, post-summary, plan-gate

**Files:**
- Modify: `src/cli/templates-default.ts` (continuing in the `SUPERVISED` const)

- [ ] **Step 1: Insert `summarize` and `post-summary` nodes after `bridge-artifacts`**

Find the section after `bridge-artifacts` in the SUPERVISED const that currently has the Phase 3 (PLAN APPROVAL GATE) comment and `plan-gate` node. Insert the following new section BETWEEN `bridge-artifacts` and `plan-gate`:

```yaml
  # ═══════════════════════════════════════════════════════════════
  # PHASE 3.5: ARCHITECTURAL SUMMARY
  # Generates a design-level analysis for human review.
  # Posted to the Linear issue AND embedded in the plan-gate message.
  # ═══════════════════════════════════════════════════════════════

  - id: summarize
    depends_on: [bridge-artifacts]
    model: haiku
    context: fresh
    prompt: |
      Produce an architectural analysis of the implementation plan for a human reviewer.
      This is a design brief — NOT a task list or implementation checklist.

      Read \$ARTIFACTS_DIR/investigation.md in full, then write \$ARTIFACTS_DIR/plan-summary.md.

      ## What to include (omit entire sections that do not apply)

      ### Approach Rationale
      Why this approach over alternatives. 1–2 sentences.

      ### Architecture & Component Design
      Which systems and layers are touched and how they interact. No file names or line numbers.

      ### UX / Interaction Patterns
      New flows, screens, state transitions, or user-facing behaviour changes.

      ### Key Design Decisions
      Trade-offs made, conventions followed, patterns chosen.

      ### Risks at a Design Level
      What could go wrong architecturally — not implementation bugs, but design concerns.

      ### Questions & Clarifications
      *(Optional — omit this section entirely if nothing is unclear)*
      Anything still ambiguous that the reviewer should be aware of before approving.

      ## Strict prohibitions
      - No file names, paths, or line numbers
      - No numbered implementation steps
      - No "we will call function X" or "modify class Y"

  - id: post-summary
    bash: |
      set -euo pipefail
      if [ ! -f "\$ARTIFACTS_DIR/plan-summary.md" ]; then
        echo "WARNING: plan-summary.md not found, skipping Linear post" >&2
        exit 0
      fi
      BODY=$(cat "\$ARTIFACTS_DIR/plan-summary.md")
      ESCAPED=$(printf '%s' "\$BODY" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
      curl -sf -X POST https://api.linear.app/graphql \\
        -H "Authorization: \$LINEAR_API_KEY" \\
        -H "Content-Type: application/json" \\
        --data "{\"query\": \"mutation { commentCreate(input: { issueId: \\\\\"\$GAGGLE_ISSUE_ID\\\\\", body: \$ESCAPED }) { success comment { id } } }\"}" \\
        -o "\$ARTIFACTS_DIR/post-summary-result.txt" \\
        || echo "WARNING: failed to post summary to Linear" >&2
    depends_on: [summarize]

```

- [ ] **Step 2: Update `plan-gate` to depend on `post-summary` and embed the summary**

Find the `plan-gate` node in the SUPERVISED const. Replace it:

**Before:**
```
  - id: plan-gate
    depends_on: [bridge-artifacts]
    approval:
      message: |
        Implementation plan is ready for your review.

        Read the full plan in the Archon run output above, then reply here:
        - **approve** (optionally with notes) — starts implementation immediately
        - **reject: <your feedback>** — triggers a revised plan addressing your concerns

        You have up to 3 revision cycles before the workflow proceeds automatically.
      capture_response: true
```

**After:**
```
  - id: plan-gate
    depends_on: [post-summary]
    approval:
      message: |
        ## Architectural Summary

        \$(cat "\$ARTIFACTS_DIR/plan-summary.md")

        ---

        The full implementation plan is in the Archon run output above.

        - **approve** (optionally with answers to any questions above) — starts implementation immediately
        - **reject: <your feedback>** — triggers a revised plan addressing your concerns

        You have up to 3 revision cycles before the workflow proceeds automatically.
      capture_response: true
```

- [ ] **Step 3: Verify the SUPERVISED string compiles without TypeScript errors**

```bash
cd C:/Repos/GaggleDispatch && bun run tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/cli/templates-default.ts
git commit -m "feat: add architectural summary node + update plan-gate in supervised template"
```

---

## Task 7: Sync updated template to trialmatch workflow files

The three trialmatch files are standalone YAML — they do NOT use TypeScript template escaping, so `$` is NOT escaped. Apply the same structural changes as Tasks 5–6 but use raw `$` everywhere.

**Files:**
- `C:/Repos/trialmatch/workflow_templates/gaggle-supervised.yaml`
- `C:/Repos/trialmatch/repos/TrialMatch-FE/.archon/workflows/gaggle/gaggle-supervised.yaml`
- `C:/Repos/trialmatch/repos/TrialMatch-BE/.archon/workflows/gaggle/gaggle-supervised.yaml`

- [ ] **Step 1: Update `C:/Repos/trialmatch/workflow_templates/gaggle-supervised.yaml`**

Apply the same three sets of changes as Tasks 5–6, but in plain YAML (no TypeScript escaping):

1. Insert the clarification phase (7 nodes: `clarify` through `clarify-merge`) between Phase 1 and Phase 2. All `$ARTIFACTS_DIR`, `$LINEAR_API_KEY`, `$GAGGLE_ISSUE_ID`, `$USER_MESSAGE` are unescaped (plain `$`).

2. Change `investigate` and `plan` nodes:
   - `depends_on: [classify]` → `depends_on: [clarify-merge]`
   - Add "## Clarification answers (if any)" context block to their prompts.

3. Insert `summarize` and `post-summary` nodes between `bridge-artifacts` and `plan-gate`.

4. Change `plan-gate`:
   - `depends_on: [bridge-artifacts]` → `depends_on: [post-summary]`
   - Replace gate message with summary-embedding version.

The YAML nodes are identical to what's in templates-default.ts except:
- Use `$ARTIFACTS_DIR` instead of `\$ARTIFACTS_DIR`
- Use `$BODY` instead of `\$BODY`
- Use `$ESCAPED` instead of `\$ESCAPED`
- Use `$LINEAR_API_KEY` instead of `\$LINEAR_API_KEY`
- Use `$GAGGLE_ISSUE_ID` instead of `\$GAGGLE_ISSUE_ID`
- Use `$USER_MESSAGE` instead of `\$USER_MESSAGE`
- Keep `$(cat ...)` as `$(cat ...)` (bash command substitution in YAML approval messages)

- [ ] **Step 2: Copy to the two deployed locations**

```bash
cp "C:/Repos/trialmatch/workflow_templates/gaggle-supervised.yaml" \
   "C:/Repos/trialmatch/repos/TrialMatch-FE/.archon/workflows/gaggle/gaggle-supervised.yaml"

cp "C:/Repos/trialmatch/workflow_templates/gaggle-supervised.yaml" \
   "C:/Repos/trialmatch/repos/TrialMatch-BE/.archon/workflows/gaggle/gaggle-supervised.yaml"
```

- [ ] **Step 3: Verify the three files are identical**

```bash
diff "C:/Repos/trialmatch/workflow_templates/gaggle-supervised.yaml" \
     "C:/Repos/trialmatch/repos/TrialMatch-FE/.archon/workflows/gaggle/gaggle-supervised.yaml"
diff "C:/Repos/trialmatch/workflow_templates/gaggle-supervised.yaml" \
     "C:/Repos/trialmatch/repos/TrialMatch-BE/.archon/workflows/gaggle/gaggle-supervised.yaml"
```

Expected: no diff output (files are identical).

- [ ] **Step 4: Commit trialmatch changes** (from the trialmatch repo root or using absolute paths)

```bash
cd C:/Repos/trialmatch && git add \
  workflow_templates/gaggle-supervised.yaml \
  repos/TrialMatch-FE/.archon/workflows/gaggle/gaggle-supervised.yaml \
  repos/TrialMatch-BE/.archon/workflows/gaggle/gaggle-supervised.yaml
git commit -m "feat: sync supervised workflow — clarification loop + architectural summary"
```

---

## Task 8: Run full test suite and verify

- [ ] **Step 1: Run all tests in GaggleDispatch**

```bash
cd C:/Repos/GaggleDispatch && bun test 2>&1 | tail -40
```

Expected: all tests pass. No failures.

- [ ] **Step 2: Type-check**

```bash
bun run tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Verify the updated default template is valid YAML**

Run a quick sanity check that the YAML embedded in templates-default.ts is well-formed by calling `writeDefaultTemplates` in a temp dir and parsing the output:

```bash
node -e "
const { writeDefaultTemplates } = require('./dist/cli/templates-default.js');
const os = require('os');
const path = require('path');
const yaml = require('yaml');
const fs = require('fs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaggle-'));
writeDefaultTemplates(dir, true);
for (const f of fs.readdirSync(dir)) {
  yaml.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  console.log('OK:', f);
}
" 2>&1
```

If the build isn't available, use bun directly:

```bash
bun -e "
import { writeDefaultTemplates } from './src/cli/templates-default.ts';
import { parse } from 'yaml';
import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const dir = mkdtempSync(join(tmpdir(), 'gaggle-'));
writeDefaultTemplates(dir, true);
for (const f of readdirSync(dir)) {
  parse(readFileSync(join(dir, f), 'utf8'));
  console.log('OK:', f);
}
" 2>&1
```

Expected: `OK: gaggle-fix-issue.yaml`, `OK: gaggle-supervised.yaml`, `OK: gaggle-scaffold.yaml`

- [ ] **Step 4: Final commit in GaggleDispatch**

```bash
cd C:/Repos/GaggleDispatch && git status
```

Confirm only intended files are modified. If anything is unstaged, add and commit with:

```bash
git commit -m "chore: verify supervised workflow improvements complete"
```

---

## Implementation notes

**Python3 availability:** The `post-summary` and `clarify-post-round-*` bash nodes use `python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))"` to JSON-escape the comment body. If `python3` is not available in the Archon bash environment, replace with `jq -Rs .` (requires `jq`). Verify which is present in the target environment before deploying.

**Archon `trigger_rule: one_success` with conditional nodes:** The `clarify-merge` node relies on Archon treating skipped (when-condition-false) nodes as "terminal" for the purpose of `trigger_rule` evaluation — the same pattern used by `bridge-artifacts`. If `clarify-merge` fires before the full chain completes, restructure to depend only on `clarify-gate-round-2` and use a simpler fallback pattern.

**YAML escaping in templates-default.ts:** In the TypeScript backtick template literal, `\$` and `$` both produce literal `$` in the output (TypeScript only interpolates `${...}`). The `\$` convention is used throughout the existing code for Archon/bash variables — follow it for consistency. The `$(cat ...)` bash command substitutions in YAML `message:` blocks are passed through as-is by Archon and evaluated by the shell at approval display time.
