/**
 * Writes a starter set of Symphony-managed Archon workflow YAML files into
 * `workflow_templates/` next to WORKFLOW.md. Used by `gaggle init`.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const FIX_ISSUE = `# symphony-fix-issue.yaml
# Default autonomous workflow. Claude reads $USER_MESSAGE, plans, implements, opens a PR.
nodes:
  - id: clarify
    loop:
      prompt: |
        You are helping implement this issue.
        Issue context: $USER_MESSAGE

        Prior answer from human (if any): $LOOP_USER_INPUT

        Decide: do you have enough information to create an implementation plan?
        - If YES: output exactly READY
        - If NO: ask ONE specific clarifying question. Be concrete and brief.
      until: READY
      interactive: true
      gate_message: "Claude has a clarifying question — reply to continue."
      max_iterations: 5

  - id: plan
    depends_on: [clarify]
    prompt: |
      Issue context: $USER_MESSAGE
      Clarification answers: $clarify.output

      Produce a detailed implementation plan. Number the steps. Identify files to touch.

  - id: implement
    depends_on: [plan]
    loop:
      prompt: |
        Issue: $USER_MESSAGE
        Plan: $plan.output

        Implement the plan. Run tests. Iterate until done. When complete, output exactly COMPLETE.
      until: COMPLETE
      max_iterations: 15
      fresh_context: true

  - id: create-pr
    depends_on: [implement]
    context: fresh
    prompt: |
      Open a pull request that references the issue URL from $USER_MESSAGE.
      Title format: "<repo_alias>: <issue title>"
      In the PR body, include a brief summary, the implementation plan, and the changes made.
`;

const SUPERVISED = `# symphony-supervised.yaml
# Supervised workflow with explicit plan-approval gate before any code changes.
nodes:
  - id: plan
    prompt: |
      Issue context: $USER_MESSAGE

      Produce a detailed implementation plan. Number the steps. Identify files and risks.

  - id: review-gate
    approval:
      message: "Implementation plan ready for review."
      capture_response: true
      on_reject:
        prompt: |
          Plan rejected. Human feedback: $REJECTION_REASON
          Revise and re-present.
        max_attempts: 3
    depends_on: [plan]

  - id: implement
    depends_on: [review-gate]
    loop:
      prompt: |
        Issue: $USER_MESSAGE
        Approved plan: $plan.output
        Human approval note: $review-gate.output

        Implement the plan. Run tests. Iterate until done. When complete, output exactly COMPLETE.
      until: COMPLETE
      max_iterations: 15
      fresh_context: true

  - id: create-pr
    depends_on: [implement]
    context: fresh
    prompt: "Open a PR that references the issue URL in $USER_MESSAGE."
`;

const SCAFFOLD = `# symphony-scaffold.yaml
# Generates a draft symphony.md for a registered repository and opens a PR for human review.
nodes:
  - id: inspect
    prompt: |
      You are bootstrapping a new repository for the GaggleDispatch system.

      Inspect this repository:
      - Read README.md, package.json/pyproject.toml/Cargo.toml/go.mod (whichever exists).
      - Inspect top-level directory layout.
      - Identify language(s), runtime(s), and any AWS service references in code or infra.
      - Identify producers/consumers and external dependencies.

      Summarize what you find.

  - id: draft
    depends_on: [inspect]
    prompt: |
      Based on the inspection, draft a \`symphony.md\` at the repo root.

      It MUST contain valid YAML front matter with:
        - name (lowercase-with-hyphens, REQUIRED)
        - description (1-3 sentences, REQUIRED)
        - default_workflow: symphony/symphony-fix-issue (REQUIRED)
        - available_workflows: at minimum [symphony/symphony-fix-issue, symphony/symphony-supervised]
        - components: at least one component (name, description, component_type, communicates_with)

      Then write a Markdown narrative body explaining how this repo is assembled, deployed,
      and what kinds of changes it typically receives.

      Do NOT commit to the default branch. Create a new branch and a draft PR titled:
      "Add symphony.md (GaggleDispatch self-description)"
`;

const TEMPLATES: Record<string, string> = {
  'symphony-fix-issue.yaml': FIX_ISSUE,
  'symphony-supervised.yaml': SUPERVISED,
  'symphony-scaffold.yaml': SCAFFOLD,
};

export function writeDefaultTemplates(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(TEMPLATES)) {
    const dest = join(dir, name);
    if (existsSync(dest)) continue;
    writeFileSync(dest, content);
  }
}
