/**
 * The bundled command library.
 *
 * Compiled into the binary rather than written to disk so a freshly registered
 * repository gets the full review phase with no setup. A repo overrides any of
 * these by creating `.gaggle/commands/<name>.md`.
 *
 * Every one of these runs with `context: fresh` and no piped input, so each
 * prompt has to (a) discover the PR and diff for itself and (b) leave its
 * findings on disk under `$ARTIFACTS_DIR` for the synthesizer to collect. That
 * shared convention is what lets the review agents run concurrently without
 * knowing about each other.
 */

/** Preamble shared by the review agents: how to find the diff, where to write. */
const REVIEW_PREAMBLE = `## Finding the change

You are reviewing an open pull request in the current working directory.

1. \`gh pr view --json number,title,body,baseRefName\` for the PR metadata.
2. \`git diff "origin/$BASE_BRANCH"...HEAD\` for the full diff. If that fails,
   fall back to \`git diff "$BASE_BRANCH"...HEAD\`, then to \`git diff HEAD~1\`.
3. Read the surrounding source for any file you intend to comment on. A diff
   hunk in isolation is not enough context to judge correctness.

## Scope

Review **only what this diff changes**. Pre-existing problems in untouched code
are out of scope — reporting them buries the findings that matter and produces
churn the author did not ask for.
`;

/** How every review agent must format its findings, so synthesis can merge them. */
const FINDINGS_FORMAT = `## Output

Write your findings to \`$ARTIFACTS_DIR/review-<AGENT>.md\` using exactly this
structure, one block per finding:

\`\`\`
### <short title>
- **severity**: blocker | major | minor | nit
- **file**: path/to/file.ts:LINE
- **problem**: one or two sentences on what is wrong
- **why it matters**: the concrete consequence — wrong output, crash, data loss,
  confusion for the next reader. If you cannot name one, it is a nit or not a
  finding at all.
- **fix**: the specific change to make
\`\`\`

Severity means:
- **blocker** — incorrect behaviour, data loss, or a security hole
- **major** — will cause a bug or an outage under a plausible input
- **minor** — real but low-impact
- **nit** — style or taste

If you find nothing, write the heading \`### No findings\` and one sentence
saying what you checked. An empty review is a legitimate result; inventing
findings to look thorough is not.

Then print a one-line summary to stdout: \`<AGENT>: N findings (B blocker, M major)\`.
`;

const PR_REVIEW_SCOPE = `# Summarise the change under review

${REVIEW_PREAMBLE}

## Task

Produce a compact factual summary of the diff for a downstream router that will
decide which specialist reviewers to run. Do **not** review anything yet.

Report:
- PR number and title
- files changed, grouped as: source / tests / docs / config / generated
- approximate lines added and removed
- whether the diff touches: error handling or async control flow; public API
  surface (exported functions, CLI flags, env vars, HTTP routes); comments or
  docstrings; test files
- the change's apparent intent in one sentence

Keep it under 40 lines. This output is read by a small model, so be terse and
concrete — no prose padding, no recommendations.
`;

const CODE_REVIEW_AGENT = `# Correctness review

${REVIEW_PREAMBLE}

## What to look for

Correctness first. In rough priority order:

1. **Logic errors** — off-by-one, inverted conditions, wrong operator, a branch
   that can never be taken, a case the author clearly meant to handle but did not.
2. **Null and boundary handling** — values that can be null/undefined/empty at
   runtime but are treated as present; array and string index edges.
3. **Concurrency** — shared mutable state, unawaited promises, races between
   check and use, missing cleanup on an error path.
4. **Resource lifetime** — files, sockets, subprocesses, timers, and DB
   connections that can leak when an error is thrown.
5. **API contract breaks** — a changed signature, return shape, or thrown type
   that existing callers still assume. Check the call sites.
6. **Security** — injection through interpolated strings, secrets in logs,
   unvalidated external input reaching a shell, a filesystem path, or a query.

For each candidate finding, before writing it down, state to yourself the input
or state that triggers it. If you cannot construct one, it is not a finding.

${FINDINGS_FORMAT.replace('<AGENT>', 'code-review')}
`;

const ERROR_HANDLING_AGENT = `# Error handling review

${REVIEW_PREAMBLE}

## What to look for

1. **Swallowed errors** — a catch block that logs nothing and rethrows nothing.
   Say what information is lost and who needed it.
2. **Over-broad catches** — a catch around a block where only one call can
   realistically fail, hiding failures from the rest.
3. **Lost context** — an error rethrown as a new one without the cause, or with
   a message that omits the identifier needed to debug it.
4. **Wrong failure mode** — continuing with a default when the correct response
   is to fail; failing hard when a degraded result was acceptable.
5. **Unhandled rejections** — async work started without \`await\` or a
   \`.catch\`, so a failure disappears.
6. **Retry hazards** — retrying an operation that is not idempotent, or
   retrying an error that will never succeed (auth, validation).
7. **Partial state** — a multi-step mutation that can fail halfway and leave
   the system inconsistent, with no cleanup or compensation.

${FINDINGS_FORMAT.replace('<AGENT>', 'error-handling')}
`;

const TEST_COVERAGE_AGENT = `# Test coverage review

${REVIEW_PREAMBLE}

## What to look for

Judge whether the tests that accompany this diff would actually catch a
regression in it.

1. **Untested new behaviour** — a new branch, function, or error path with no
   test exercising it. Name the specific uncovered path.
2. **Tests that cannot fail** — assertions so loose they pass regardless
   (\`expect(result).toBeDefined()\` on a function that always returns an
   object), or a mock so complete the real code never runs.
3. **Missing edge cases** — empty input, boundary values, the error path, and
   concurrent invocation, where those are plausible for this code.
4. **Changed behaviour with unchanged tests** — a modified function whose tests
   were not touched. Either the tests were not specific enough to notice, or
   the behaviour change is unintended. Say which you think it is.
5. **Fragility** — reliance on timing, ordering, network, or real dates, which
   will flake in CI.

Read the existing test files before claiming something is untested. Follow the
project's existing test conventions when proposing a fix; do not import a
framework the repo does not already use.

${FINDINGS_FORMAT.replace('<AGENT>', 'test-coverage')}
`;

const COMMENT_QUALITY_AGENT = `# Comment quality review

${REVIEW_PREAMBLE}

## What to look for

A good comment explains **why**; the code already says what. Flag:

1. **Restating the code** — \`// increment i\` above \`i++\`. Pure noise.
2. **Stale comments** — a comment that contradicts the code it sits above.
   This is worse than no comment; readers trust it.
3. **Missing rationale** — a non-obvious constant, an unusual algorithm, a
   deliberate deviation from the surrounding style, or a workaround for an
   external bug, with nothing explaining the reason. These are the comments
   worth adding.
4. **Commented-out code** — should be deleted; git remembers it.
5. **Placeholders left behind** — TODO/FIXME/XXX with no owner or issue link,
   added by this diff.
6. **Wrong doc comments** — a docstring whose parameters, return type, or
   thrown errors no longer match the signature.

Be strict about proposing *fewer* comments, not more. Do not ask for a
docstring on every function; ask for one where a reader would otherwise be
stuck.

${FINDINGS_FORMAT.replace('<AGENT>', 'comment-quality')}
`;

const DOCS_IMPACT_AGENT = `# Documentation impact review

${REVIEW_PREAMBLE}

## What to look for

Find user-facing changes in this diff whose documentation was not updated.

1. **New or changed public surface** — exported functions, CLI commands and
   flags, environment variables, config keys, HTTP routes, database columns.
2. **Removed surface** — anything deleted that the docs still describe.
3. **Changed defaults** — a default value, timeout, or limit that the docs
   still state with the old number.
4. **Setup and migration** — a change that requires an operator to do something
   (run a migration, set a new variable, install a dependency) with no note
   saying so.
5. **Examples that no longer work** — a README snippet using an API this diff
   changed.

Search the repo for existing documentation before reporting: README, docs/,
CLAUDE.md, gaggle.md, and any \`--help\` text in the source. Point at the exact
file and section that needs the edit, and say what it should say.

${FINDINGS_FORMAT.replace('<AGENT>', 'docs-impact')}
`;

const SYNTHESIZE_REVIEW = `# Merge the review findings

Several review agents ran concurrently and each wrote its findings to
\`$ARTIFACTS_DIR\`. Some may not have run at all — that is expected, the router
only starts the ones relevant to this diff.

## Task

1. Read every \`$ARTIFACTS_DIR/review-*.md\` that exists. Missing files are
   fine; do not fail on them.
2. Merge into a single prioritised list:
   - **Deduplicate.** Two agents reporting the same line from different angles
     is one finding — keep the clearer description and the higher severity.
   - **Drop findings that contradict the code.** Re-read the file before
     keeping anything you doubt. A confidently wrong finding costs more than a
     missed one, because the self-fix step will act on it.
   - **Drop out-of-scope findings** about code this diff does not touch.
3. Order by severity, then by how cheap the fix is.

## Output

Write \`$ARTIFACTS_DIR/review-synthesis.md\`:

\`\`\`
## Summary
<2-3 sentences: overall state of the change, and whether anything blocks merge>

## Findings
### 1. <title>  [severity]
- **file**: path:line
- **problem**: ...
- **fix**: ...

### 2. ...

## Dropped
- <finding> — <why it was dropped: duplicate of #N / not supported by the code / out of scope>
\`\`\`

The **Dropped** section is not optional. It is the record that keeps the review
honest and lets a human check the filtering.

Print to stdout: \`synthesis: N findings kept (B blocker, M major), D dropped\`.
`;

const SELF_FIX_ALL = `# Apply the review findings

Read \`$ARTIFACTS_DIR/review-synthesis.md\`. If it does not exist or lists no
findings, print \`self-fix: nothing to do\` and stop.

## Rules

1. Work in severity order: blockers, then major, then minor. Skip nits unless
   they are a one-line change in a file you are already editing.
2. **Fix the cause, not the symptom.** If a finding says a value can be null,
   establish why it can be null and handle it at the right level rather than
   adding a guard at the crash site.
3. Re-read the code before each fix. The finding was written by a reviewer who
   may have been wrong — if you conclude a finding is incorrect, skip it and
   record why. Do not implement a change you believe is wrong.
4. Add or update a test for every blocker and major fix. A fix with no test is
   a fix that regresses.
5. Run the project's tests after each group of related fixes. Fix what you
   break before moving on.
6. Stay inside the scope of the original change. Do not refactor adjacent code
   because you are passing through.
7. Commit incrementally with messages that say what was fixed and why, then
   push to the PR branch.

## Output

Write \`$ARTIFACTS_DIR/self-fix-report.md\` listing, for each finding: fixed /
skipped, and for skipped ones the reason. Print
\`self-fix: F fixed, S skipped\` to stdout.
`;

const SIMPLIFY_CHANGES = `# Simplification pass

Review only the code this PR changed, for clarity rather than correctness — a
separate pass already covered correctness.

## Look for

1. **Duplication introduced by this change** — logic that now exists twice, or
   that duplicates a helper the repo already has. Search before concluding
   something is new.
2. **Unnecessary indirection** — a wrapper that adds nothing, an option nobody
   passes, a layer with one caller.
3. **Dead code** — a branch that cannot be reached, a parameter never read, an
   export nobody imports.
4. **Overly clever expressions** — a nested ternary or chained reduce that a
   plain loop or an early return would make obvious.
5. **Inconsistency with the surrounding file** — naming, error style, or
   structure that does not match its neighbours.

## Rules

- Behaviour must not change. If a simplification would alter observable
  behaviour in any case, however unlikely, do not make it.
- Run the tests after each change.
- Prefer no change to a marginal one. A diff that only moves code around costs
  a reviewer time and buys nothing.

Commit and push what you change. Write
\`$ARTIFACTS_DIR/simplify-report.md\` with what you changed and what you
deliberately left alone, and print \`simplify: N changes\` to stdout.
`;

const ISSUE_COMPLETION_REPORT = `# Report on the completed work

Summarise this run for the human who will review the pull request.

## Gather

- The issue context from \`$USER_MESSAGE\`.
- \`$ARTIFACTS_DIR/investigation.md\` — the plan or root-cause analysis.
- \`$ARTIFACTS_DIR/review-synthesis.md\` — what review found.
- \`$ARTIFACTS_DIR/self-fix-report.md\` and \`simplify-report.md\` — what was
  done about it.
- \`git log "origin/$BASE_BRANCH"..HEAD --oneline\` and the final diffstat.
- \`gh pr view --json number,url,title\`.

Any of these may be missing. Work with what is there.

## Write

Post a comment on the PR with \`gh pr comment\`, structured as:

\`\`\`
## What changed
<2-4 sentences in plain language: the problem, and the approach taken. Written
for someone who has not read the diff.>

## Files touched
<grouped list with a phrase on each, not a bare file listing>

## Review and fixes
<what review found, what was fixed, and — importantly — anything that was
skipped and why>

## What a reviewer should check
<the 2-3 specific things most worth a human's attention: a judgement call made,
an assumption relied on, a piece with thinner test coverage>

## Not done
<anything in the issue that was deliberately left out, and why. Say "nothing"
if the issue is fully addressed.>
\`\`\`

Be accurate over flattering. If the change is partial, uncertain, or rests on
an assumption that might be wrong, say so plainly — that is the single most
useful thing this report can contain. Do not claim tests pass unless you ran
them and saw them pass.

Print the PR URL to stdout.
`;

export const BUNDLED_COMMANDS: Record<string, string> = {
  'pr-review-scope': PR_REVIEW_SCOPE,
  'code-review-agent': CODE_REVIEW_AGENT,
  'error-handling-agent': ERROR_HANDLING_AGENT,
  'test-coverage-agent': TEST_COVERAGE_AGENT,
  'comment-quality-agent': COMMENT_QUALITY_AGENT,
  'docs-impact-agent': DOCS_IMPACT_AGENT,
  'synthesize-review': SYNTHESIZE_REVIEW,
  'self-fix-all': SELF_FIX_ALL,
  'simplify-changes': SIMPLIFY_CHANGES,
  'issue-completion-report': ISSUE_COMPLETION_REPORT,
};

export const BUNDLED_COMMAND_NAMES = Object.keys(BUNDLED_COMMANDS);
