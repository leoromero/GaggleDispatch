/**
 * Scheduling and variable substitution — the two pure halves of the engine.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBashPath } from '../executor/engine/shell.ts';
import { runBash } from '../executor/engine/nodes/shell.ts';
import type { NodeStatus } from '../executor/types.ts';
import {
  isSettled,
  plan,
  runOutcome,
  topologicalLayers,
  triggerSatisfied,
  type NodeStateMap,
} from '../executor/engine/planner.ts';
import { parseWorkflow } from '../executor/engine/loader.ts';
import {
  appendContextIfAbsent,
  MissingBaseBranchError,
  substitute,
  type SubstitutionContext,
} from '../executor/engine/substitute.ts';

const wf = (nodes: string) =>
  parseWorkflow(`name: t\ndescription: d\nnodes:\n${nodes}`, '/t.yaml').workflow;

const states = (m: Record<string, NodeStatus>): NodeStateMap => new Map(Object.entries(m));
const noWhen = () => null;

describe('isSettled', () => {
  test('terminal statuses settle, in-flight ones do not', () => {
    for (const s of ['completed', 'failed', 'skipped', 'cancelled'] as NodeStatus[]) {
      expect(isSettled(s)).toBe(true);
    }
    for (const s of ['pending', 'running', 'interrupted'] as NodeStatus[]) {
      expect(isSettled(s)).toBe(false);
    }
  });
});

describe('topologicalLayers', () => {
  test('independent nodes share a layer', () => {
    const w = wf(`  - id: a\n    bash: x\n  - id: b\n    bash: y`);
    expect(topologicalLayers(w.nodes)).toEqual([['a', 'b']]);
  });

  test('dependencies push nodes into later layers', () => {
    const w = wf(
      `  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]\n  - id: c\n    bash: z\n    depends_on: [b]`,
    );
    expect(topologicalLayers(w.nodes)).toEqual([['a'], ['b'], ['c']]);
  });

  test('a diamond joins in the final layer', () => {
    const w = wf(
      `  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]\n  - id: c\n    bash: z\n    depends_on: [a]\n  - id: d\n    bash: w\n    depends_on: [b, c]`,
    );
    expect(topologicalLayers(w.nodes)).toEqual([['a'], ['b', 'c'], ['d']]);
  });
});

describe('triggerSatisfied', () => {
  test('a node with no dependencies always fires', () => {
    for (const rule of ['all_success', 'one_success', 'all_done', 'none_failed_min_one_success'] as const) {
      expect(triggerSatisfied(rule, [])).toBe(true);
    }
  });

  test('all_success needs every dependency completed', () => {
    expect(triggerSatisfied('all_success', ['completed', 'completed'])).toBe(true);
    expect(triggerSatisfied('all_success', ['completed', 'skipped'])).toBe(false);
    expect(triggerSatisfied('all_success', ['completed', 'failed'])).toBe(false);
  });

  test('one_success needs at least one', () => {
    // This is the rule bridge-artifacts uses to join the investigate/plan
    // branches, exactly one of which runs.
    expect(triggerSatisfied('one_success', ['completed', 'skipped'])).toBe(true);
    expect(triggerSatisfied('one_success', ['skipped', 'skipped'])).toBe(false);
    expect(triggerSatisfied('one_success', ['failed', 'completed'])).toBe(true);
  });

  test('none_failed_min_one_success tolerates skips but not failures', () => {
    expect(triggerSatisfied('none_failed_min_one_success', ['completed', 'skipped'])).toBe(true);
    expect(triggerSatisfied('none_failed_min_one_success', ['completed', 'failed'])).toBe(false);
    expect(triggerSatisfied('none_failed_min_one_success', ['skipped', 'skipped'])).toBe(false);
  });

  test('all_done accepts any settled combination', () => {
    expect(triggerSatisfied('all_done', ['failed', 'skipped', 'cancelled'])).toBe(true);
  });

  test('a cancelled dependency counts as failed', () => {
    expect(triggerSatisfied('all_success', ['cancelled'])).toBe(false);
    expect(triggerSatisfied('none_failed_min_one_success', ['completed', 'cancelled'])).toBe(false);
  });
});

describe('plan', () => {
  test('starts root nodes first', () => {
    const w = wf(`  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]`);
    const step = plan({ nodes: w.nodes, states: states({}), evaluateWhen: noWhen });
    expect(step.ready).toEqual(['a']);
  });

  test('does not start a node while a dependency is running', () => {
    const w = wf(`  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]`);
    const step = plan({ nodes: w.nodes, states: states({ a: 'running' }), evaluateWhen: noWhen });
    expect(step.ready).toEqual([]);
    expect(step.finished).toBe(false);
  });

  test('releases a dependent once its dependency completes', () => {
    const w = wf(`  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]`);
    const step = plan({ nodes: w.nodes, states: states({ a: 'completed' }), evaluateWhen: noWhen });
    expect(step.ready).toEqual(['b']);
  });

  test('runs independent nodes concurrently', () => {
    const w = wf(`  - id: a\n    bash: x\n  - id: b\n    bash: y\n  - id: c\n    bash: z`);
    expect(plan({ nodes: w.nodes, states: states({}), evaluateWhen: noWhen }).ready).toEqual(['a', 'b', 'c']);
  });

  test('skips a node whose trigger rule cannot be met', () => {
    const w = wf(
      `  - id: a\n    bash: x\n  - id: b\n    bash: y\n  - id: c\n    bash: z\n    depends_on: [a, b]`,
    );
    const step = plan({
      nodes: w.nodes,
      states: states({ a: 'completed', b: 'failed' }),
      evaluateWhen: noWhen,
    });
    expect(step.ready).toEqual([]);
    expect(step.skip).toHaveLength(1);
    expect(step.skip[0]!.node_id).toBe('c');
    expect(step.skip[0]!.reason).toContain('all_success');
    // The reason names the offending dependency, so a log line is actionable.
    expect(step.skip[0]!.reason).toContain('b=failed');
  });

  test('one_success releases the join when a sibling branch was skipped', () => {
    const w = wf(
      `  - id: inv\n    bash: x\n  - id: plan\n    bash: y\n  - id: bridge\n    bash: z\n    depends_on: [inv, plan]\n    trigger_rule: one_success`,
    );
    const step = plan({
      nodes: w.nodes,
      states: states({ inv: 'completed', plan: 'skipped' }),
      evaluateWhen: noWhen,
    });
    expect(step.ready).toEqual(['bridge']);
  });

  test('skips a node whose when expression is false', () => {
    const w = wf(`  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]\n    when: "$a.output == 'go'"`);
    const step = plan({
      nodes: w.nodes,
      states: states({ a: 'completed' }),
      evaluateWhen: () => ({ value: false, error: null }),
    });
    expect(step.ready).toEqual([]);
    expect(step.skip[0]!.reason).toContain('when expression is false');
  });

  test('an unevaluable when expression skips fail-closed and says so', () => {
    const w = wf(`  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]\n    when: "$a.output == 'go'"`);
    const step = plan({
      nodes: w.nodes,
      states: states({ a: 'completed' }),
      evaluateWhen: () => ({ value: false, error: 'cannot parse' }),
    });
    expect(step.skip[0]!.reason).toContain('fail-closed');
  });

  test('a true when expression lets the node run', () => {
    const w = wf(`  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]\n    when: "$a.output == 'go'"`);
    const step = plan({
      nodes: w.nodes,
      states: states({ a: 'completed' }),
      evaluateWhen: () => ({ value: true, error: null }),
    });
    expect(step.ready).toEqual(['b']);
  });

  test('skip propagates to dependants', () => {
    const w = wf(
      `  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]\n  - id: c\n    bash: z\n    depends_on: [b]`,
    );
    // b was skipped; c requires all_success, so it cannot run either.
    const step = plan({
      nodes: w.nodes,
      states: states({ a: 'completed', b: 'skipped' }),
      evaluateWhen: noWhen,
    });
    expect(step.ready).toEqual([]);
    expect(step.skip.map((s) => s.node_id)).toEqual(['c']);
  });

  test('reports finished only when every node has settled', () => {
    const w = wf(`  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]`);
    expect(
      plan({ nodes: w.nodes, states: states({ a: 'completed', b: 'completed' }), evaluateWhen: noWhen })
        .finished,
    ).toBe(true);
    expect(
      plan({ nodes: w.nodes, states: states({ a: 'completed' }), evaluateWhen: noWhen }).finished,
    ).toBe(false);
  });

  test('is idempotent — planning twice gives the same answer', () => {
    const w = wf(`  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]`);
    const s = states({ a: 'completed' });
    expect(plan({ nodes: w.nodes, states: s, evaluateWhen: noWhen })).toEqual(
      plan({ nodes: w.nodes, states: s, evaluateWhen: noWhen }),
    );
  });
});

describe('runOutcome', () => {
  test('all completed is a success', () => {
    expect(runOutcome(states({ a: 'completed', b: 'completed' }))).toBe('succeeded');
  });

  test('skipped branches do not fail the run', () => {
    expect(runOutcome(states({ a: 'completed', b: 'skipped' }))).toBe('succeeded');
  });

  test('any failure fails the run', () => {
    expect(runOutcome(states({ a: 'completed', b: 'failed' }))).toBe('failed');
  });

  test('cancellation wins over failure', () => {
    expect(runOutcome(states({ a: 'failed', b: 'cancelled' }))).toBe('cancelled');
  });
});

// ── substitution ────────────────────────────────────────────────────────────

const ctx = (over: Partial<SubstitutionContext> = {}): SubstitutionContext => ({
  arguments: 'fix the bug',
  workflowId: 'run-1',
  artifactsDir: '/artifacts/run-1',
  baseBranch: 'main',
  nodeOutputs: new Map(),
  ...over,
});

describe('substitute — scalars', () => {
  test('replaces the documented variables', () => {
    const r = substitute('$ARGUMENTS | $USER_MESSAGE | $WORKFLOW_ID | $ARTIFACTS_DIR | $BASE_BRANCH', ctx());
    expect(r.text).toBe('fix the bug | fix the bug | run-1 | /artifacts/run-1 | main');
  });

  test('context aliases all resolve to the same value', () => {
    const r = substitute('$CONTEXT/$EXTERNAL_CONTEXT/$ISSUE_CONTEXT', ctx({ context: 'ISS-1' }));
    expect(r.text).toBe('ISS-1/ISS-1/ISS-1');
  });

  test('absent optional variables become empty strings', () => {
    expect(substitute('[$LOOP_USER_INPUT][$REJECTION_REASON][$CONTEXT]', ctx()).text).toBe('[][][]');
  });

  test('$BASE_BRANCH throws rather than substituting empty', () => {
    // Branching from '' would silently do the wrong thing on a real repo.
    expect(() => substitute('from $BASE_BRANCH', ctx({ baseBranch: null }))).toThrow(
      MissingBaseBranchError,
    );
  });

  test('an unresolvable base branch is fine when never referenced', () => {
    expect(substitute('no branch here', ctx({ baseBranch: null })).text).toBe('no branch here');
  });

  test('leaves unknown shell variables alone', () => {
    const r = substitute('echo $spent and $HOME and $1', ctx());
    expect(r.text).toBe('echo $spent and $HOME and $1');
  });

  test('leaves ${...} shell syntax alone', () => {
    const r = substitute('if [ ${PIPESTATUS[0]} -eq 0 ]; then :; fi', ctx());
    expect(r.text).toBe('if [ ${PIPESTATUS[0]} -eq 0 ]; then :; fi');
  });

  test('a longer variable name is not shadowed by a shorter prefix', () => {
    // $USER_MESSAGE must not be read as $USER + "_MESSAGE".
    expect(substitute('$USER_MESSAGE', ctx()).text).toBe('fix the bug');
  });

  test('substitution is single-pass — an injected value is not re-expanded', () => {
    const r = substitute('$ARGUMENTS', ctx({ arguments: 'contains $WORKFLOW_ID literally' }));
    expect(r.text).toBe('contains $WORKFLOW_ID literally');
  });

  test('honours \\$ escapes only when asked', () => {
    expect(substitute('\\$ARGUMENTS', ctx(), { allowEscapes: true }).text).toBe('$ARGUMENTS');
    // Shell bodies keep their own escaping semantics.
    expect(substitute('\\$ARGUMENTS', ctx(), { allowEscapes: false }).text).toBe('\\$ARGUMENTS');
  });

  test('a bare $ passes through', () => {
    expect(substitute('costs $ and $ 5', ctx()).text).toBe('costs $ and $ 5');
  });
});

describe('substitute — node outputs', () => {
  const withOutputs = () =>
    ctx({
      nodeOutputs: new Map([
        ['classify', { text: '{"issue_type":"bug"}', json: { issue_type: 'bug' } }],
        ['snapshot-root', { text: 'file listing' }],
      ]),
    });

  test('injects full node output', () => {
    expect(substitute('saw $snapshot-root.output', withOutputs()).text).toBe('saw file listing');
  });

  test('injects a structured field', () => {
    expect(substitute('type=$classify.output.issue_type', withOutputs()).text).toBe('type=bug');
  });

  test('parses JSON from text when the node had no declared output_format', () => {
    const c = ctx({ nodeOutputs: new Map([['b', { text: '{"n":7}' }]]) });
    expect(substitute('$b.output.n', c).text).toBe('7');
  });

  test('an unknown node resolves empty and is reported', () => {
    const r = substitute('x=$ghost.output', ctx());
    expect(r.text).toBe('x=');
    expect(r.unresolved).toEqual(['$ghost.output']);
  });

  test('an absent field resolves empty and is reported', () => {
    const r = substitute('$classify.output.nope', withOutputs());
    expect(r.text).toBe('');
    expect(r.unresolved).toEqual(['$classify.output.nope']);
  });

  test('binds node output to the environment in shell bodies', () => {
    const c = ctx({ nodeOutputs: new Map([['a', { text: "it's; rm -rf /" }]]) });
    const r = substitute('echo $a.output', c, { shell: true });
    expect(r.text).toBe('echo ${GAGGLE_OUT_A}');
    expect(r.bindings).toEqual({ GAGGLE_OUT_A: "it's; rm -rf /" });
  });

  test('does not bind node output in prompts or script bodies', () => {
    const c = ctx({ nodeOutputs: new Map([['a', { text: '{"k":1}' }]]) });
    const r = substitute('const d = $a.output;', c, { shell: false });
    expect(r.text).toBe('const d = {"k":1};');
    expect(r.bindings).toEqual({});
  });

  test('hyphenated node ids resolve', () => {
    expect(substitute('$snapshot-root.output', withOutputs()).text).toBe('file listing');
  });

  test('a node id without .output is left alone', () => {
    expect(substitute('$classify is a node', withOutputs()).text).toBe('$classify is a node');
  });
});

describe('appendContextIfAbsent', () => {
  test('appends when the template never mentions context', () => {
    expect(appendContextIfAbsent('do work', 'ISS-1 details')).toBe('do work\n\n---\n\nISS-1 details');
  });

  test('leaves the template alone when it places context itself', () => {
    expect(appendContextIfAbsent('see $CONTEXT', 'ISS-1')).toBe('see $CONTEXT');
    expect(appendContextIfAbsent('see $ISSUE_CONTEXT', 'ISS-1')).toBe('see $ISSUE_CONTEXT');
  });

  test('is a no-op when there is no context', () => {
    expect(appendContextIfAbsent('do work', undefined)).toBe('do work');
    expect(appendContextIfAbsent('do work', '   ')).toBe('do work');
  });
});

// ── review finding: untrusted text must be neutralised in shell bodies ──────

describe('substitute — shell injection', () => {
  const evil = "x'; touch /tmp/pwned; echo '";

  test('untrusted scalars become environment references in shell bodies', () => {
    // $ARGUMENTS carries the Linear issue title and body. The shipped Archon
    // docs put it straight into a `bash:` node, so leaving it raw let issue
    // text execute as shell.
    for (const name of ['ARGUMENTS', 'USER_MESSAGE', 'CONTEXT', 'LOOP_USER_INPUT', 'REJECTION_REASON']) {
      const r = substitute(`gh issue view $${name}`, ctx({
        arguments: evil, context: evil, loopUserInput: evil, rejectionReason: evil,
      }), { shell: true });
      expect(r.text, name).toBe(`gh issue view \${GAGGLE_VAR_${name}}`);
      expect(r.bindings[`GAGGLE_VAR_${name}`], name).toBe(evil);
    }
  });

  test('one binding per distinct value, reused on repeat references', () => {
    const c = ctx({ arguments: evil, nodeOutputs: new Map([['a', { text: 'out' }]]) });
    const r = substitute('$ARGUMENTS $a.output $ARGUMENTS $a.output', c, { shell: true });
    expect(r.text).toBe('${GAGGLE_VAR_ARGUMENTS} ${GAGGLE_OUT_A} ${GAGGLE_VAR_ARGUMENTS} ${GAGGLE_OUT_A}');
    expect(Object.keys(r.bindings).sort()).toEqual(['GAGGLE_OUT_A', 'GAGGLE_VAR_ARGUMENTS']);
  });

  test('node ids that sanitise to the same env name get distinct bindings', () => {
    // `a-b` and `a_b` both become A_B; colliding would hand one node the
    // other's output, which is a correctness bug as much as a safety one.
    const c = ctx({ nodeOutputs: new Map([['a-b', { text: 'dash' }], ['a_b', { text: 'under' }]]) });
    const r = substitute('$a-b.output|$a_b.output', c, { shell: true });
    expect(r.bindings.GAGGLE_OUT_A_B).toBe('dash');
    expect(r.bindings.GAGGLE_OUT_A_B_2).toBe('under');
    expect(r.text).toBe('${GAGGLE_OUT_A_B}|${GAGGLE_OUT_A_B_2}');
  });

  test('a structured field binds separately from the whole output', () => {
    const c = ctx({ nodeOutputs: new Map([['a', { text: '{"k":"v"}', json: { k: 'v' } }]]) });
    const r = substitute('$a.output $a.output.k', c, { shell: true });
    expect(r.bindings.GAGGLE_OUT_A).toBe('{"k":"v"}');
    expect(r.bindings.GAGGLE_OUT_A_K).toBe('v');
  });

  test('the expansion is inert when a real shell runs it — quoted and unquoted', async () => {
    // The definitive check: the substituted script must not execute the
    // payload. Asserting on the string alone would pass for a scheme that
    // merely looks right — and the previous shell-quoting scheme did look
    // right while being unsafe inside double quotes, which is the context
    // every shipped template actually uses.
    const bash = resolveBashPath();
    if (!bash) return; // covered by the string assertions above on hosts without bash

    const sub = join(tmpdir(), `gaggle-inject-sub-${Date.now()}.txt`).replace(/\\/g, '/');
    const bt = join(tmpdir(), `gaggle-inject-bt-${Date.now()}.txt`).replace(/\\/g, '/');
    const payload = `$(touch '${sub}') \`touch '${bt}'\` and 'quotes'`;

    const r = substitute('printf "%s" "$ARGUMENTS"; printf "|%s" $ARGUMENTS', ctx({ arguments: payload }), {
      shell: true,
    });

    const out = await runBash({
      script: r.text,
      cwd: tmpdir(),
      env: { ...(process.env as Record<string, string>), ...r.bindings },
      timeoutMs: 15_000,
      bashPath: bash,
    });

    expect(out.exit_code).toBe(0);
    expect(existsSync(sub), 'command substitution must not run').toBe(false);
    expect(existsSync(bt), 'backticks must not run').toBe(false);
    // Quoted: verbatim. Unquoted: word-split by the shell, which is the
    // author's business — the point is that no part of it was executed.
    expect(out.stdout.startsWith(payload)).toBe(true);
    expect(out.stdout).toContain('|$(touch');
  });

  test('engine-controlled paths are left raw so quoted usage still works', () => {
    // Templates write "$ARTIFACTS_DIR/notes.md"; binding would leave a
    // parameter reference where a path belongs and gain nothing — the value
    // is the engine's own, not anyone else's text.
    const r = substitute('cat "$ARTIFACTS_DIR/notes.md"', ctx(), { shell: true });
    expect(r.text).toBe('cat "/artifacts/run-1/notes.md"');
    expect(r.bindings).toEqual({});
  });

  test('prompts are never bound, only expanded', () => {
    const r = substitute('The task: $ARGUMENTS', ctx({ arguments: evil }), { shell: false });
    expect(r.text).toBe(`The task: ${evil}`);
    expect(r.bindings).toEqual({});
  });
});
