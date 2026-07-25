/**
 * Writes a starter set of Symphony-managed Archon workflow YAML files into
 * `workflow_templates/` next to WORKFLOW.md. Used by `gaggle init`.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const FIX_ISSUE = `name: gaggle/gaggle-fix-issue
description: |
  Fully autonomous workflow. Classifies the issue, researches context (bug investigation
  or feature planning), implements, validates, opens a draft PR, runs multi-agent code
  review, self-fixes all findings, simplifies, and posts a completion report.
  All issue context is read from $USER_MESSAGE — no human interaction required.

provider: claude
model: sonnet

nodes:
  # ═══════════════════════════════════════════════════════════════
  # PHASE 1: CLASSIFY
  # ═══════════════════════════════════════════════════════════════

  - id: classify
    model: haiku
    allowed_tools: []
    prompt: |
      Classify the issue described below.

      $USER_MESSAGE

      | Type          | Indicators                                                            |
      |---------------|-----------------------------------------------------------------------|
      | bug           | "broken", "error", "crash", "doesn't work", stack traces, regression  |
      | feature       | "add", "new", "support", "would be nice", net-new capability          |
      | enhancement   | "improve", "better", "update existing", "extend", incremental         |
      | refactor      | "clean up", "simplify", "reorganize", "restructure"                   |
      | chore         | "update deps", "upgrade", "maintenance", "CI/CD"                     |
      | documentation | "docs", "readme", "clarify", "examples"                               |
    output_format:
      type: object
      properties:
        issue_type:
          type: string
          enum: ["bug", "feature", "enhancement", "refactor", "chore", "documentation"]
        reasoning:
          type: string
      required: [issue_type, reasoning]

  # ═══════════════════════════════════════════════════════════════
  # PHASE 2: RESEARCH
  # ═══════════════════════════════════════════════════════════════

  - id: investigate
    depends_on: [classify]
    when: "$classify.output.issue_type == 'bug'"
    context: fresh
    prompt: |
      You are investigating a bug. Fully understand the root cause before any fix is attempted.

      ## Issue context

      $USER_MESSAGE

      ## Instructions

      1. Read the relevant source files, tests, and recent git history for the components
         mentioned in the issue context.
      2. Trace execution from the entry point to the failure: identify the exact lines and
         functions responsible and explain why they produce the wrong behaviour.
      3. Find all call sites affected by the bug.
      4. Propose a concrete fix approach — do NOT implement yet.

      Save your findings to \$ARTIFACTS_DIR/investigation.md:
      - Root cause (1–2 sentences)
      - Affected files and line numbers
      - Proposed fix approach (numbered steps)
      - Edge cases and risks to watch for

  - id: plan
    depends_on: [classify]
    when: "$classify.output.issue_type != 'bug'"
    context: fresh
    prompt: |
      You are planning an implementation. Produce a plan detailed enough for a separate
      agent to execute without ambiguity.

      ## Issue context

      $USER_MESSAGE

      ## Instructions

      1. Read relevant source files to understand the current architecture and conventions.
      2. Identify every file that must be created or modified, with the reason for each.
      3. Note any API contracts, interfaces, or external dependencies this change touches.
      4. Flag decisions, trade-offs, and risks the implementer must know about.

      Save your plan to \$ARTIFACTS_DIR/investigation.md:
      - Goal (1–2 sentences)
      - Files to create/modify (with purpose)
      - Implementation steps (numbered)
      - Risks and open decisions

  - id: bridge-artifacts
    bash: |
      mkdir -p "\$ARTIFACTS_DIR"
      if [ ! -f "\$ARTIFACTS_DIR/investigation.md" ]; then
        echo "WARNING: no investigation.md produced" > "\$ARTIFACTS_DIR/investigation.md"
      fi
      echo "Artifact check complete"
    depends_on: [investigate, plan]
    trigger_rule: one_success

  # ═══════════════════════════════════════════════════════════════
  # PHASE 3: IMPLEMENT
  # ═══════════════════════════════════════════════════════════════

  - id: implement
    depends_on: [bridge-artifacts]
    context: fresh
    model: opus
    loop:
      prompt: |
        Implement the fix or feature described below. Follow the research/plan exactly.

        ## Issue context

        $USER_MESSAGE

        ## Research / Plan

        Read \$ARTIFACTS_DIR/investigation.md in full before writing a single line of code.

        ## Rules

        - Work through the plan steps in order.
        - After each significant change, run the relevant tests to confirm nothing is broken.
        - Commit changes incrementally with meaningful messages — do not leave everything uncommitted.
        - Do not modify files outside the scope defined in the plan.
        - If you discover that this change requires work in ANOTHER repository or library that
          does not yet exist (e.g. a shared package needs a new API, a library version must be
          bumped upstream), DO NOT guess or work around it. Instead:
          1. Write \$ARTIFACTS_DIR/blocker-request.md with exactly this format:
               title: <one-line description of what the other repo must do>
               description: <why this issue depends on it and what specifically is needed>
          2. Output exactly: COMPLETE
          GaggleDispatch will detect the blocker file, create the upstream issue, block this
          issue on it, and restart implementation automatically once the blocker is resolved.
        - When all steps are complete and tests pass, output exactly: COMPLETE
      until: COMPLETE
      max_iterations: 20
      fresh_context: true

  - id: check-blocker
    bash: |
      set -euo pipefail
      if [ -f "\$ARTIFACTS_DIR/blocker-request.md" ]; then
        echo "BLOCKER"
      else
        echo "CONTINUE"
      fi
    depends_on: [implement]

  - id: blocker-gate
    approval:
      message: |
        CREATE_BLOCKER
        $(grep "^title:" "\$ARTIFACTS_DIR/blocker-request.md" | sed 's/^title: *//')
        $(grep -A 1000 "^description:" "\$ARTIFACTS_DIR/blocker-request.md" | tail -n +2)
      capture_response: false
    depends_on: [check-blocker]
    when: "$check-blocker.output == 'BLOCKER'"

  # ═══════════════════════════════════════════════════════════════
  # PHASE 4: VALIDATE
  # ═══════════════════════════════════════════════════════════════

  - id: validate-script
    # 30 min — Archon's default 120s isn't enough for real test suites
    # (TS build + unit tests + E2E commonly exceed it). Tune per repo.
    timeout: 1800000
    bash: |
      mkdir -p "\$ARTIFACTS_DIR"
      if [ -f ".gaggle/validate.sh" ]; then
        echo "[validate] running .gaggle/validate.sh"
        bash .gaggle/validate.sh 2>&1 | tee "\$ARTIFACTS_DIR/validation.txt"
        if [ \${PIPESTATUS[0]} -eq 0 ]; then
          echo "SCRIPT_OK" > "\$ARTIFACTS_DIR/.validate-mode"
        else
          echo "SCRIPT_FAILED" > "\$ARTIFACTS_DIR/.validate-mode"
        fi
      else
        echo "FALLBACK" > "\$ARTIFACTS_DIR/.validate-mode"
      fi
      exit 0
    depends_on: [check-blocker]
    when: "$check-blocker.output == 'CONTINUE'"

  - id: validate
    depends_on: [validate-script]
    context: fresh
    prompt: |
      Validate the implementation before opening a PR.

      First, check how validation ran:
      \`\`\`bash
      cat "\$ARTIFACTS_DIR/.validate-mode"
      \`\`\`

      If the mode is SCRIPT_OK:
      - Read \`\$ARTIFACTS_DIR/validation.txt\` — these are the real test results.
      - If there are no failures, write a summary to \`\$ARTIFACTS_DIR/validation.md\` and proceed.
      - If any failures are shown, fix them and re-run \`bash .gaggle/validate.sh\`, repeating until green.

      If the mode is SCRIPT_FAILED:
      - Read \`\$ARTIFACTS_DIR/validation.txt\` — these are the failed test/lint/type-check results.
      - Diagnose and fix every failure, then re-run \`bash .gaggle/validate.sh\` until it exits 0.
      - Write a summary to \`\$ARTIFACTS_DIR/validation.md\`.

      If the mode is FALLBACK (no .gaggle/validate.sh found):
      - Discover the test runner: check for bun.lockb, pnpm-lock.yaml, yarn.lock, package-lock.json,
        pyproject.toml, Cargo.toml, go.mod.
      - Run the full test suite, type checks, and linting appropriate for this stack.
      - Fix any failures.
      - Write a summary to \`\$ARTIFACTS_DIR/validation.md\`.
      - Suggest creating a \`.gaggle/validate.sh\` file with the commands you used so future
        runs are deterministic. Add it to a commit if the human approves.

      The summary in \`\$ARTIFACTS_DIR/validation.md\` must include:
      - Test results (pass/fail counts)
      - Type check / lint status
      - Build status
      - Verification notes

      Only mark validation complete when everything passes.

  # ═══════════════════════════════════════════════════════════════
  # PHASE 5: CREATE DRAFT PR
  # ═══════════════════════════════════════════════════════════════

  - id: create-pr
    depends_on: [validate]
    context: fresh
    prompt: |
      Create a draft pull request for the current branch.

      ## Issue context

      $USER_MESSAGE

      ## Instructions

      1. Check git status. Stage and commit any remaining source changes:
         - Use \`git add <specific files>\` — never \`git add -A\` or \`git add .\`
         - Never commit scratch files, review artifacts, or anything under \$ARTIFACTS_DIR
      2. Push the branch: \`git push -u origin HEAD\`
      3. Check if a PR already exists: \`gh pr list --head $(git branch --show-current)\`
         - If one exists, capture its number and skip creation.
      4. Look for a PR template at \`.github/pull_request_template.md\`,
         \`.github/PULL_REQUEST_TEMPLATE.md\`, or \`docs/PULL_REQUEST_TEMPLATE.md\`.
      5. Create a DRAFT PR: \`gh pr create --draft --base $BASE_BRANCH\`
         - Title: concise, imperative mood, under 70 chars
         - Fill every PR template section using \$ARTIFACTS_DIR/investigation.md,
           \$ARTIFACTS_DIR/implementation.md, and \$ARTIFACTS_DIR/validation.md.
           If no template, write: summary, changes made, validation evidence, and a
           Fixes/Closes line referencing the issue URL from $USER_MESSAGE.
         - Write the body to \$ARTIFACTS_DIR/pr-body.md and use \`--body-file\`.
           Never write body files inside the worktree.
      6. Save PR identifiers:
         \`\`\`bash
         gh pr view --json number -q '.number' > "\$ARTIFACTS_DIR/.pr-number"
         gh pr view --json url -q '.url' > "\$ARTIFACTS_DIR/.pr-url"
         \`\`\`

  # ═══════════════════════════════════════════════════════════════
  # PHASE 6: REVIEW
  # ═══════════════════════════════════════════════════════════════

  - id: verify-pr-base
    bash: |
      set -euo pipefail
      ACTUAL=$(gh pr view --json baseRefName -q '.baseRefName')
      if [ "$ACTUAL" != "$BASE_BRANCH" ]; then
        PR_NUMBER=$(gh pr view --json number -q '.number')
        gh pr edit "$PR_NUMBER" --base "$BASE_BRANCH"
        echo "Re-targeted PR #$PR_NUMBER base to $BASE_BRANCH"
      else
        echo "PR base verified: $BASE_BRANCH"
      fi
    depends_on: [create-pr]

  - id: review-scope
    command: archon-pr-review-scope
    depends_on: [verify-pr-base]
    context: fresh

  - id: review-classify
    model: haiku
    allowed_tools: []
    context: fresh
    depends_on: [review-scope]
    prompt: |
      Decide which review agents to run for this PR.

      $review-scope.output

      Rules:
      - run_code_review: ALWAYS true — mandatory for every PR.
      - run_error_handling: true if the diff touches error handling, try/catch, async paths,
        or introduces new failure modes.
      - run_test_coverage: true if the diff changes source code (not only tests, docs, or config).
      - run_comment_quality: true if the diff adds or modifies comments, docstrings, or JSDoc.
      - run_docs_impact: true if the diff adds/removes public APIs, CLI flags, env vars,
        or any user-facing feature.
    output_format:
      type: object
      properties:
        run_code_review:
          type: string
          enum: ["true", "false"]
        run_error_handling:
          type: string
          enum: ["true", "false"]
        run_test_coverage:
          type: string
          enum: ["true", "false"]
        run_comment_quality:
          type: string
          enum: ["true", "false"]
        run_docs_impact:
          type: string
          enum: ["true", "false"]
        reasoning:
          type: string
      required:
        - run_code_review
        - run_error_handling
        - run_test_coverage
        - run_comment_quality
        - run_docs_impact
        - reasoning

  - id: code-review
    command: archon-code-review-agent
    depends_on: [review-classify]
    context: fresh

  - id: error-handling
    command: archon-error-handling-agent
    depends_on: [review-classify]
    when: "$review-classify.output.run_error_handling == 'true'"
    context: fresh

  - id: test-coverage
    command: archon-test-coverage-agent
    depends_on: [review-classify]
    when: "$review-classify.output.run_test_coverage == 'true'"
    context: fresh

  - id: comment-quality
    command: archon-comment-quality-agent
    depends_on: [review-classify]
    when: "$review-classify.output.run_comment_quality == 'true'"
    context: fresh

  - id: docs-impact
    command: archon-docs-impact-agent
    depends_on: [review-classify]
    when: "$review-classify.output.run_docs_impact == 'true'"
    context: fresh

  # ═══════════════════════════════════════════════════════════════
  # PHASE 7: SYNTHESIZE + SELF-FIX + SIMPLIFY
  # ═══════════════════════════════════════════════════════════════

  - id: synthesize
    command: archon-synthesize-review
    depends_on: [code-review, error-handling, test-coverage, comment-quality, docs-impact]
    trigger_rule: one_success
    context: fresh

  - id: self-fix
    command: archon-self-fix-all
    depends_on: [synthesize]
    context: fresh

  - id: simplify
    command: archon-simplify-changes
    depends_on: [self-fix]
    context: fresh

  # ═══════════════════════════════════════════════════════════════
  # PHASE 8: REPORT
  # ═══════════════════════════════════════════════════════════════

  - id: report
    command: archon-issue-completion-report
    depends_on: [simplify]
    context: fresh
`;

const SUPERVISED = `name: gaggle/gaggle-supervised
description: |
  Supervised workflow. Classifies, researches, and produces a plan — then pauses for
  human approval before writing any code. You can reject the plan with feedback and
  receive a revised version (up to 3 cycles). After approval the workflow implements,
  validates, opens a draft PR, runs multi-agent review, self-fixes, and reports.

provider: claude
model: sonnet

nodes:
  # ═══════════════════════════════════════════════════════════════
  # PHASE 1: CLASSIFY
  # ═══════════════════════════════════════════════════════════════

  - id: classify
    model: haiku
    allowed_tools: []
    prompt: |
      Classify the issue described below.

      $USER_MESSAGE

      | Type          | Indicators                                                            |
      |---------------|-----------------------------------------------------------------------|
      | bug           | "broken", "error", "crash", "doesn't work", stack traces, regression  |
      | feature       | "add", "new", "support", "would be nice", net-new capability          |
      | enhancement   | "improve", "better", "update existing", "extend", incremental         |
      | refactor      | "clean up", "simplify", "reorganize", "restructure"                   |
      | chore         | "update deps", "upgrade", "maintenance", "CI/CD"                     |
      | documentation | "docs", "readme", "clarify", "examples"                               |
    output_format:
      type: object
      properties:
        issue_type:
          type: string
          enum: ["bug", "feature", "enhancement", "refactor", "chore", "documentation"]
        reasoning:
          type: string
      required: [issue_type, reasoning]

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
        --data "{\\"query\\": \\"mutation { commentCreate(input: { issueId: \\\\\\"\\$GAGGLE_ISSUE_ID\\\\\\", body: \\$ESCAPED }) { success } }\\"}" \\
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

        $(cat "\$ARTIFACTS_DIR/questions.md")

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
        --data "{\\"query\\": \\"mutation { commentCreate(input: { issueId: \\\\\\"\\$GAGGLE_ISSUE_ID\\\\\\", body: \\$ESCAPED }) { success } }\\"}" \\
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

        $(cat "\$ARTIFACTS_DIR/questions.md")

        Please answer these follow-up questions.
      capture_response: true

  - id: clarify-append-round-2
    bash: |
      set -euo pipefail
      printf '%s\\n' "\$clarify-gate-round-2.output" >> "\$ARTIFACTS_DIR/answers.md"
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

  # ═══════════════════════════════════════════════════════════════
  # PHASE 2: RESEARCH
  # ═══════════════════════════════════════════════════════════════

  - id: investigate
    depends_on: [clarify-merge]
    when: "$classify.output.issue_type == 'bug'"
    context: fresh
    prompt: |
      You are investigating a bug. Fully understand the root cause before any fix is attempted.

      ## Issue context

      $USER_MESSAGE

      ## Clarification answers (if any)

      If \$ARTIFACTS_DIR/answers.md exists, read it before investigating — it contains
      human-provided context that may affect the scope of the fix.

      ## Instructions

      1. Read the relevant source files, tests, and recent git history for the components
         mentioned in the issue context.
      2. Trace execution from the entry point to the failure: identify the exact lines and
         functions responsible and explain why they produce the wrong behaviour.
      3. Find all call sites affected by the bug.
      4. Propose a concrete fix approach — do NOT implement yet.

      Save your findings to \$ARTIFACTS_DIR/investigation.md:
      - Root cause (1–2 sentences)
      - Affected files and line numbers
      - Proposed fix approach (numbered steps)
      - Edge cases and risks to watch for

  - id: plan
    depends_on: [clarify-merge]
    when: "$classify.output.issue_type != 'bug'"
    context: fresh
    prompt: |
      You are planning an implementation. Produce a plan detailed enough for a separate
      agent to execute without ambiguity.

      ## Issue context

      $USER_MESSAGE

      ## Clarification answers (if any)

      If \$ARTIFACTS_DIR/answers.md exists, read it before planning — it contains
      human-provided context that must shape the implementation plan.

      ## Instructions

      1. Read relevant source files to understand the current architecture and conventions.
      2. Identify every file that must be created or modified, with the reason for each.
      3. Note any API contracts, interfaces, or external dependencies this change touches.
      4. Flag decisions, trade-offs, and risks the implementer must know about.

      Save your plan to \$ARTIFACTS_DIR/investigation.md:
      - Goal (1–2 sentences)
      - Files to create/modify (with purpose)
      - Implementation steps (numbered)
      - Risks and open decisions

  - id: bridge-artifacts
    bash: |
      mkdir -p "\$ARTIFACTS_DIR"
      if [ ! -f "\$ARTIFACTS_DIR/investigation.md" ]; then
        echo "WARNING: no investigation.md produced" > "\$ARTIFACTS_DIR/investigation.md"
      fi
      echo "Artifact check complete"
    depends_on: [investigate, plan]
    trigger_rule: one_success

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
        echo "WARNING: plan-summary.md not found" >&2
        echo "(no architectural summary available)"
        exit 0
      fi
      BODY=$(cat "\$ARTIFACTS_DIR/plan-summary.md")
      ESCAPED=$(printf '%s' "\$BODY" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
      curl -sf -X POST https://api.linear.app/graphql \\
        -H "Authorization: \$LINEAR_API_KEY" \\
        -H "Content-Type: application/json" \\
        --data "{\\"query\\": \\"mutation { commentCreate(input: { issueId: \\\\\\"\\$GAGGLE_ISSUE_ID\\\\\\", body: \\$ESCAPED }) { success comment { id } } }\\"}" \\
        -o "\$ARTIFACTS_DIR/post-summary-result.txt" \\
        || echo "WARNING: failed to post summary to Linear" >&2
      cat "\$ARTIFACTS_DIR/plan-summary.md"
    depends_on: [summarize]

  # ═══════════════════════════════════════════════════════════════
  # PHASE 3: PLAN APPROVAL GATE
  # Human sees the plan summary in the gate comment and in Archon output.
  # Reply "approve" (or any positive response) to start implementation.
  # Reply "reject" with your feedback to receive a revised plan — up to 3 cycles.
  # ═══════════════════════════════════════════════════════════════

  - id: plan-gate
    depends_on: [post-summary]
    approval:
      message: |
        ## Architectural Summary

        $post-summary.output

        ---

        The full implementation plan is in the Archon run output above.

        - **approve** (optionally with answers to any questions above) — starts implementation immediately
        - **reject: <your feedback>** — triggers a revised plan addressing your concerns

        You have up to 3 revision cycles before the workflow proceeds automatically.
      capture_response: true
      on_reject:
        prompt: |
          The implementation plan was rejected with this feedback:

          > $REJECTION_REASON

          ## Issue context

          $USER_MESSAGE

          ## Your task

          1. Read the current plan from \$ARTIFACTS_DIR/investigation.md.
          2. Revise it to address every concern in the feedback above.
             - Keep steps that were not criticised.
             - Be specific and actionable in your changes.
          3. Save the revised plan back to \$ARTIFACTS_DIR/investigation.md (overwrite).
          4. Present the full revised plan clearly so the human can review it again.
        max_attempts: 3

  # ═══════════════════════════════════════════════════════════════
  # PHASE 4: IMPLEMENT
  # ═══════════════════════════════════════════════════════════════

  - id: implement
    depends_on: [plan-gate]
    context: fresh
    model: opus
    loop:
      prompt: |
        Implement the approved fix or feature. Follow the plan exactly.

        ## Issue context

        $USER_MESSAGE

        ## Approved plan

        Read \$ARTIFACTS_DIR/investigation.md in full before writing a single line of code.

        ## Human approval notes (if any)

        $plan-gate.output

        ## Rules

        - Work through the plan steps in order.
        - After each significant change, run the relevant tests to confirm nothing is broken.
        - Commit changes incrementally with meaningful messages.
        - Do not modify files outside the scope defined in the plan.
        - When all steps are complete and tests pass, output exactly: COMPLETE
      until: COMPLETE
      max_iterations: 20
      fresh_context: true

  # ═══════════════════════════════════════════════════════════════
  # PHASE 5: VALIDATE
  # ═══════════════════════════════════════════════════════════════

  - id: validate-script
    # 30 min — Archon's default 120s isn't enough for real test suites
    # (TS build + unit tests + E2E commonly exceed it). Tune per repo.
    timeout: 1800000
    bash: |
      mkdir -p "\$ARTIFACTS_DIR"
      if [ -f ".gaggle/validate.sh" ]; then
        echo "[validate] running .gaggle/validate.sh"
        bash .gaggle/validate.sh 2>&1 | tee "\$ARTIFACTS_DIR/validation.txt"
        if [ \${PIPESTATUS[0]} -eq 0 ]; then
          echo "SCRIPT_OK" > "\$ARTIFACTS_DIR/.validate-mode"
        else
          echo "SCRIPT_FAILED" > "\$ARTIFACTS_DIR/.validate-mode"
        fi
      else
        echo "FALLBACK" > "\$ARTIFACTS_DIR/.validate-mode"
      fi
      exit 0
    depends_on: [implement]

  - id: validate
    depends_on: [validate-script]
    context: fresh
    prompt: |
      Validate the implementation before opening a PR.

      First, check how validation ran:
      \`\`\`bash
      cat "\$ARTIFACTS_DIR/.validate-mode"
      \`\`\`

      If the mode is SCRIPT_OK:
      - Read \`\$ARTIFACTS_DIR/validation.txt\` — these are the real test results.
      - If there are no failures, write a summary to \`\$ARTIFACTS_DIR/validation.md\` and proceed.
      - If any failures are shown, fix them and re-run \`bash .gaggle/validate.sh\`, repeating until green.

      If the mode is SCRIPT_FAILED:
      - Read \`\$ARTIFACTS_DIR/validation.txt\` — these are the failed test/lint/type-check results.
      - Diagnose and fix every failure, then re-run \`bash .gaggle/validate.sh\` until it exits 0.
      - Write a summary to \`\$ARTIFACTS_DIR/validation.md\`.

      If the mode is FALLBACK (no .gaggle/validate.sh found):
      - Discover the test runner: check for bun.lockb, pnpm-lock.yaml, yarn.lock, package-lock.json,
        pyproject.toml, Cargo.toml, go.mod.
      - Run the full test suite, type checks, and linting appropriate for this stack.
      - Fix any failures.
      - Write a summary to \`\$ARTIFACTS_DIR/validation.md\`.
      - Suggest creating a \`.gaggle/validate.sh\` file with the commands you used so future
        runs are deterministic. Add it to a commit if the human approves.

      The summary in \`\$ARTIFACTS_DIR/validation.md\` must include:
      - Test results (pass/fail counts)
      - Type check / lint status
      - Build status
      - Verification notes

      Only mark validation complete when everything passes.

  # ═══════════════════════════════════════════════════════════════
  # PHASE 6: CREATE DRAFT PR
  # ═══════════════════════════════════════════════════════════════

  - id: create-pr
    depends_on: [validate]
    context: fresh
    prompt: |
      Create a draft pull request for the current branch.

      ## Issue context

      $USER_MESSAGE

      ## Instructions

      1. Check git status. Stage and commit any remaining source changes:
         - Use \`git add <specific files>\` — never \`git add -A\` or \`git add .\`
         - Never commit scratch files, review artifacts, or anything under \$ARTIFACTS_DIR
      2. Push the branch: \`git push -u origin HEAD\`
      3. Check if a PR already exists: \`gh pr list --head $(git branch --show-current)\`
         - If one exists, capture its number and skip creation.
      4. Look for a PR template at \`.github/pull_request_template.md\`,
         \`.github/PULL_REQUEST_TEMPLATE.md\`, or \`docs/PULL_REQUEST_TEMPLATE.md\`.
      5. Create a DRAFT PR: \`gh pr create --draft --base $BASE_BRANCH\`
         - Title: concise, imperative mood, under 70 chars
         - Fill every PR template section using \$ARTIFACTS_DIR/investigation.md,
           \$ARTIFACTS_DIR/implementation.md, and \$ARTIFACTS_DIR/validation.md.
           If no template, write: summary, changes made, validation evidence, and a
           Fixes/Closes line referencing the issue URL from $USER_MESSAGE.
         - Write the body to \$ARTIFACTS_DIR/pr-body.md and use \`--body-file\`.
           Never write body files inside the worktree.
      6. Save PR identifiers:
         \`\`\`bash
         gh pr view --json number -q '.number' > "\$ARTIFACTS_DIR/.pr-number"
         gh pr view --json url -q '.url' > "\$ARTIFACTS_DIR/.pr-url"
         \`\`\`

  # ═══════════════════════════════════════════════════════════════
  # PHASE 7: REVIEW
  # ═══════════════════════════════════════════════════════════════

  - id: verify-pr-base
    bash: |
      set -euo pipefail
      ACTUAL=$(gh pr view --json baseRefName -q '.baseRefName')
      if [ "$ACTUAL" != "$BASE_BRANCH" ]; then
        PR_NUMBER=$(gh pr view --json number -q '.number')
        gh pr edit "$PR_NUMBER" --base "$BASE_BRANCH"
        echo "Re-targeted PR #$PR_NUMBER base to $BASE_BRANCH"
      else
        echo "PR base verified: $BASE_BRANCH"
      fi
    depends_on: [create-pr]

  - id: review-scope
    command: archon-pr-review-scope
    depends_on: [verify-pr-base]
    context: fresh

  - id: review-classify
    model: haiku
    allowed_tools: []
    context: fresh
    depends_on: [review-scope]
    prompt: |
      Decide which review agents to run for this PR.

      $review-scope.output

      Rules:
      - run_code_review: ALWAYS true — mandatory for every PR.
      - run_error_handling: true if the diff touches error handling, try/catch, async paths,
        or introduces new failure modes.
      - run_test_coverage: true if the diff changes source code (not only tests, docs, or config).
      - run_comment_quality: true if the diff adds or modifies comments, docstrings, or JSDoc.
      - run_docs_impact: true if the diff adds/removes public APIs, CLI flags, env vars,
        or any user-facing feature.
    output_format:
      type: object
      properties:
        run_code_review:
          type: string
          enum: ["true", "false"]
        run_error_handling:
          type: string
          enum: ["true", "false"]
        run_test_coverage:
          type: string
          enum: ["true", "false"]
        run_comment_quality:
          type: string
          enum: ["true", "false"]
        run_docs_impact:
          type: string
          enum: ["true", "false"]
        reasoning:
          type: string
      required:
        - run_code_review
        - run_error_handling
        - run_test_coverage
        - run_comment_quality
        - run_docs_impact
        - reasoning

  - id: code-review
    command: archon-code-review-agent
    depends_on: [review-classify]
    context: fresh

  - id: error-handling
    command: archon-error-handling-agent
    depends_on: [review-classify]
    when: "$review-classify.output.run_error_handling == 'true'"
    context: fresh

  - id: test-coverage
    command: archon-test-coverage-agent
    depends_on: [review-classify]
    when: "$review-classify.output.run_test_coverage == 'true'"
    context: fresh

  - id: comment-quality
    command: archon-comment-quality-agent
    depends_on: [review-classify]
    when: "$review-classify.output.run_comment_quality == 'true'"
    context: fresh

  - id: docs-impact
    command: archon-docs-impact-agent
    depends_on: [review-classify]
    when: "$review-classify.output.run_docs_impact == 'true'"
    context: fresh

  # ═══════════════════════════════════════════════════════════════
  # PHASE 8: SYNTHESIZE + SELF-FIX + SIMPLIFY
  # ═══════════════════════════════════════════════════════════════

  - id: synthesize
    command: archon-synthesize-review
    depends_on: [code-review, error-handling, test-coverage, comment-quality, docs-impact]
    trigger_rule: one_success
    context: fresh

  - id: self-fix
    command: archon-self-fix-all
    depends_on: [synthesize]
    context: fresh

  - id: simplify
    command: archon-simplify-changes
    depends_on: [self-fix]
    context: fresh

  # ═══════════════════════════════════════════════════════════════
  # PHASE 9: REPORT
  # ═══════════════════════════════════════════════════════════════

  - id: report
    command: archon-issue-completion-report
    depends_on: [simplify]
    context: fresh
`;

const SCAFFOLD = `name: gaggle/gaggle-scaffold
description: Generates a draft gaggle.md for a registered repository and opens a PR for human review.
nodes:
  - id: inspect
    prompt: |
      You are bootstrapping a new repository for the GaggleDispatch AI routing system.
      Your goal is to produce a concise self-description so an AI orchestrator can decide
      which repos to involve when an issue arrives.

      Inspect ONLY files that belong to this repo:
      - README.md and top-level directory layout.
      - Build/package file (package.json, pyproject.toml, Cargo.toml, go.mod, *.csproj/sln).
      - CI/CD workflows (.github/workflows/).
      - Infrastructure files (Dockerfile, docker-compose, ecs/, cdk/).
      - List external service names from config/env files — do NOT read external service source code.

      Answer these questions:
      1. What deployable artifacts does THIS repo produce? (services, lambdas, containers)
      2. What external services does this repo call? (just names — e.g. "PostgreSQL", "AWS SQS")
      3. What is the deployment target and trigger?
      4. What kinds of changes land here most often?

  - id: draft
    depends_on: [inspect]
    prompt: |
      Based on the inspection, draft a \`gaggle.md\` at the repo root.

      YAML front matter rules:
        - name: lowercase-with-hyphens slug for this repo (REQUIRED)
        - description: 2-3 sentences — what this repo does and why it exists (REQUIRED)
        - default_workflow: gaggle/gaggle-fix-issue (REQUIRED)
        - available_workflows: [gaggle/gaggle-fix-issue, gaggle/gaggle-supervised]
        - components: one entry per deployable artifact THIS REPO PRODUCES (REQUIRED)

      CRITICAL — components ownership rule:
        - A component entry belongs here ONLY if its code lives in and is deployed from THIS REPO.
        - External services, databases, cloud APIs, and other repos are NOT components.
        - Reference every external dependency ONLY as a plain string inside \`communicates_with\`.
        - WRONG: listing \`postgresql\` or \`trialmatch-api\` as a component block.
        - RIGHT: \`communicates_with: [postgresql, trialmatch-api]\` inside the component that calls them.

      Narrative body rules (Markdown, after the front matter):
        - Focus on THIS repo only: how it is built, tested, and deployed.
        - Describe external dependencies from THIS repo's perspective (e.g. "calls the API at BASE_URL")
          — do NOT describe how those external systems work internally.
        - Include: source layout, deployment pipeline, and a table of typical change classes.
        - Keep it concise — this is routing context, not a tutorial.

      Do NOT commit to the default branch. Create a new branch and a PR titled:
      "Add gaggle.md (GaggleDispatch self-description)"
`;

export const TEMPLATES: Record<string, string> = {
  'gaggle-fix-issue.yaml': FIX_ISSUE,
  'gaggle-supervised.yaml': SUPERVISED,
  'gaggle-scaffold.yaml': SCAFFOLD,
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

export function writeDefaultTemplates(dir: string, force = false): { written: string[]; skipped: string[] } {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const skipped: string[] = [];
  for (const [name, content] of Object.entries(TEMPLATES)) {
    const dest = join(dir, name);
    if (!force && existsSync(dest)) {
      skipped.push(name);
      continue;
    }
    writeFileSync(dest, content);
    written.push(name);
  }
  return { written, skipped };
}

