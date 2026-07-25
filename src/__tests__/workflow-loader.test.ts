/**
 * Workflow loading and DAG validation.
 *
 * The load-the-real-templates block at the bottom is the important one: it is
 * what proves the engine can run the workflows GaggleDispatch actually ships,
 * rather than only the toy ones written here.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  discoverWorkflowFiles,
  hashWorkflow,
  isInlineScript,
  loadWorkflowFile,
  parseWorkflow,
  WorkflowLoadError,
} from '../executor/engine/loader.ts';
import { findCycle, validateWorkflow } from '../executor/engine/validate.ts';
import { TEMPLATES } from '../cli/templates-default.ts';

const load = (yaml: string) => parseWorkflow(yaml, '/wf/test.yaml');

/** Minimal valid document; extend via the `nodes` argument. */
const doc = (nodes: string, top = '') => `
name: test/wf
description: a test workflow
${top}
nodes:
${nodes}
`;

function expectLoadError(yaml: string): WorkflowLoadError {
  try {
    load(yaml);
  } catch (err) {
    return err as WorkflowLoadError;
  }
  throw new Error('expected the workflow to fail loading');
}

describe('parseWorkflow — shape', () => {
  test('loads a minimal prompt workflow with defaults applied', () => {
    const { workflow } = load(doc(`  - id: a\n    prompt: "hi"`));
    expect(workflow.name).toBe('test/wf');
    expect(workflow.interactive).toBe(false);
    expect(workflow.nodes).toHaveLength(1);
    const n = workflow.nodes[0]!;
    expect(n.type).toBe('prompt');
    expect(n.depends_on).toEqual([]);
    expect(n.trigger_rule).toBe('all_success');
    expect(n.side_effects).toBe('idempotent');
  });

  test('detects each node type', () => {
    const yaml = doc(
      [
        `  - id: p\n    prompt: "x"`,
        `  - id: c\n    command: some-command`,
        `  - id: b\n    bash: "echo hi"`,
        `  - id: s\n    script: "console.log(1)"\n    runtime: bun`,
        `  - id: l\n    loop:\n      prompt: "go"\n      until: DONE\n      max_iterations: 3`,
        `  - id: g\n    approval:\n      message: "ok?"`,
        `  - id: x\n    cancel: "nope"`,
      ].join('\n'),
    );
    const { workflow } = load(yaml);
    expect(workflow.nodes.map((n) => n.type)).toEqual([
      'prompt', 'command', 'bash', 'script', 'loop', 'approval', 'cancel',
    ]);
  });

  test('rejects a node with two body fields', () => {
    const err = expectLoadError(doc(`  - id: a\n    prompt: "x"\n    bash: "y"`));
    expect(err.diagnostics.some((d) => d.message.includes('mutually exclusive'))).toBe(true);
  });

  test('rejects a node with no body field', () => {
    const err = expectLoadError(doc(`  - id: a\n    depends_on: []`));
    expect(err.diagnostics.some((d) => d.message.includes('no body'))).toBe(true);
  });

  test('rejects a node with no id', () => {
    const err = expectLoadError(doc(`  - prompt: "x"`));
    expect(err.diagnostics.some((d) => d.message.includes("missing an 'id'"))).toBe(true);
  });

  test('rejects the deprecated steps: format outright', () => {
    expect(() => load(`name: x\nsteps:\n  - id: a\n`)).toThrow(/steps.*removed/i);
  });

  test('requires a non-empty nodes list', () => {
    expect(() => load(`name: x\nnodes: []`)).toThrow(/non-empty 'nodes'/);
  });

  test('requires a workflow name', () => {
    const err = expectLoadError(`description: d\nnodes:\n  - id: a\n    prompt: "x"`);
    expect(err.diagnostics.some((d) => d.message.includes("'name' is required"))).toBe(true);
  });

  test('surfaces invalid YAML with the source path', () => {
    expect(() => parseWorkflow('name: [unclosed', '/wf/bad.yaml')).toThrow(/bad\.yaml.*invalid YAML/s);
  });
});

describe('parseWorkflow — node options', () => {
  test('script nodes require a runtime', () => {
    const err = expectLoadError(doc(`  - id: s\n    script: "print(1)"`));
    expect(err.diagnostics.some((d) => d.message.includes("runtime: 'bun' or 'uv'"))).toBe(true);
  });

  test('warns that deps is ignored for bun scripts', () => {
    const { warnings } = load(doc(`  - id: s\n    script: "x"\n    runtime: bun\n    deps: ["pandas"]`));
    expect(warnings.some((w) => w.message.includes('deps is uv-only'))).toBe(true);
  });

  test('retry on a loop node is a hard error', () => {
    const err = expectLoadError(
      doc(`  - id: l\n    loop:\n      prompt: p\n      until: D\n      max_iterations: 2\n    retry:\n      max_attempts: 2`),
    );
    expect(err.diagnostics.some((d) => d.message.includes('retry is not supported on loop'))).toBe(true);
  });

  test('retry bounds are enforced', () => {
    expect(
      expectLoadError(doc(`  - id: a\n    bash: x\n    retry:\n      max_attempts: 9`)).diagnostics.some(
        (d) => d.message.includes('between 1 and 5'),
      ),
    ).toBe(true);
    expect(
      expectLoadError(
        doc(`  - id: a\n    bash: x\n    retry:\n      max_attempts: 2\n      delay_ms: 10`),
      ).diagnostics.some((d) => d.message.includes('between 1000 and 60000')),
    ).toBe(true);
  });

  test('an interactive loop must carry a gate message', () => {
    const err = expectLoadError(
      doc(`  - id: l\n    loop:\n      prompt: p\n      until: D\n      max_iterations: 2\n      interactive: true`),
    );
    expect(err.diagnostics.some((d) => d.message.includes('gate_message is required'))).toBe(true);
  });

  test('approval requires a non-empty message', () => {
    const err = expectLoadError(doc(`  - id: g\n    approval:\n      message: "  "`));
    expect(err.diagnostics.some((d) => d.message.includes('approval.message is required'))).toBe(true);
  });

  test('on_reject.max_attempts is bounded to 1..10', () => {
    const err = expectLoadError(
      doc(`  - id: g\n    approval:\n      message: ok\n      on_reject:\n        prompt: fix\n        max_attempts: 25`),
    );
    expect(err.diagnostics.some((d) => d.message.includes('between 1 and 10'))).toBe(true);
  });

  test('cancel requires a reason', () => {
    const err = expectLoadError(doc(`  - id: x\n    cancel: ""`));
    expect(err.diagnostics.some((d) => d.message.includes('non-empty reason'))).toBe(true);
  });

  test('an unknown trigger_rule is rejected', () => {
    const err = expectLoadError(doc(`  - id: a\n    bash: x\n    trigger_rule: sometimes`));
    expect(err.diagnostics.some((d) => d.message.includes('trigger_rule'))).toBe(true);
  });

  test('AI-only fields on a bash node produce a warning, not silence', () => {
    const { warnings } = load(doc(`  - id: a\n    bash: "x"\n    model: opus\n    allowed_tools: []`));
    const w = warnings.find((x) => x.node_id === 'a');
    expect(w?.message).toContain('do not invoke AI');
    expect(w?.message).toContain('model');
  });

  test('side_effects: at_most_once is carried through', () => {
    const { workflow } = load(doc(`  - id: pr\n    prompt: "open a PR"\n    side_effects: at_most_once`));
    expect(workflow.nodes[0]!.side_effects).toBe('at_most_once');
  });

  test('an unknown side_effects value is rejected', () => {
    const err = expectLoadError(doc(`  - id: a\n    bash: x\n    side_effects: maybe`));
    expect(err.diagnostics.some((d) => d.message.includes('side_effects'))).toBe(true);
  });

  test('interactive is parsed but never warned about', () => {
    // The flag is vestigial: a gate always pauses the run and persists its
    // message, so there is no delivery channel to get wrong.
    const off = load(doc(`  - id: g\n    approval:\n      message: "ok?"`));
    expect(off.workflow.interactive).toBe(false);
    expect(off.warnings.some((w) => w.message.includes('interactive'))).toBe(false);

    const on = load(doc(`  - id: g\n    approval:\n      message: "ok?"`, 'interactive: true'));
    expect(on.workflow.interactive).toBe(true);
    expect(on.warnings).toEqual([]);
  });
});

describe('hashWorkflow', () => {
  test('is stable across formatting and comment changes', () => {
    const a = load(doc(`  - id: a\n    prompt: "hi"`)).workflow.hash;
    const b = load(
      `# leading comment\nname: test/wf\ndescription: a test workflow\nnodes:\n  - id: a\n    prompt: "hi"\n`,
    ).workflow.hash;
    expect(a).toBe(b);
  });

  test('changes when a node body changes', () => {
    const a = load(doc(`  - id: a\n    prompt: "hi"`)).workflow.hash;
    const b = load(doc(`  - id: a\n    prompt: "different"`)).workflow.hash;
    expect(a).not.toBe(b);
  });

  test('changes when a node is added', () => {
    const a = load(doc(`  - id: a\n    prompt: "hi"`)).workflow.hash;
    const b = load(doc(`  - id: a\n    prompt: "hi"\n  - id: b\n    bash: "x"`)).workflow.hash;
    expect(a).not.toBe(b);
  });

  test('does not depend on the source path', () => {
    const yaml = doc(`  - id: a\n    prompt: "hi"`);
    expect(parseWorkflow(yaml, '/one.yaml').workflow.hash).toBe(
      parseWorkflow(yaml, '/two.yaml').workflow.hash,
    );
  });

  test('is deterministic for equal inputs', () => {
    const base = { name: 'n', description: 'd', interactive: false, nodes: [] };
    expect(hashWorkflow(base as never)).toBe(hashWorkflow(base as never));
  });
});

describe('isInlineScript', () => {
  test('treats a bare identifier as a named script', () => {
    expect(isInlineScript('analyze-metrics')).toBe(false);
    expect(isInlineScript('group/analyze')).toBe(false);
  });

  test('treats anything with code punctuation or newlines as inline', () => {
    expect(isInlineScript('console.log(1)')).toBe(true);
    expect(isInlineScript('a\nb')).toBe(true);
    expect(isInlineScript('echo $X')).toBe(true);
  });
});

describe('validateWorkflow — graph rules', () => {
  const v = (yaml: string) => validateWorkflow(load(yaml).workflow);

  test('accepts a well-formed DAG', () => {
    const res = v(doc(`  - id: a\n    bash: "x"\n  - id: b\n    bash: "y"\n    depends_on: [a]`));
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test('flags a dangling dependency and suggests a near match', () => {
    const res = v(doc(`  - id: classify\n    bash: "x"\n  - id: b\n    bash: "y"\n    depends_on: [classifu]`));
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.message).toContain("unknown node 'classifu'");
    expect(res.errors[0]!.message).toContain("did you mean 'classify'");
  });

  test('flags a self-dependency', () => {
    const res = v(doc(`  - id: a\n    bash: "x"\n    depends_on: [a]`));
    expect(res.errors.some((e) => e.message.includes('depends on itself'))).toBe(true);
  });

  test('detects a cycle and names the path', () => {
    const res = v(
      doc(`  - id: a\n    bash: x\n    depends_on: [c]\n  - id: b\n    bash: y\n    depends_on: [a]\n  - id: c\n    bash: z\n    depends_on: [b]`),
    );
    expect(res.ok).toBe(false);
    const cycleErr = res.errors.find((e) => e.message.startsWith('dependency cycle'));
    expect(cycleErr).toBeDefined();
    expect(cycleErr!.message).toContain('->');
  });

  test('findCycle returns null for a DAG', () => {
    const { workflow } = load(doc(`  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]`));
    expect(findCycle(workflow.nodes)).toBeNull();
  });

  test('rejects an output reference to an unknown node', () => {
    const res = v(doc(`  - id: a\n    prompt: "see $ghost.output"`));
    expect(res.errors.some((e) => e.message.includes("unknown node '$ghost.output'"))).toBe(true);
  });

  test('rejects a node referencing its own output', () => {
    const res = v(doc(`  - id: a\n    prompt: "loop $a.output"`));
    expect(res.errors.some((e) => e.message.includes('its own output'))).toBe(true);
  });

  test('warns when a referenced node is not an upstream dependency', () => {
    const res = v(doc(`  - id: a\n    bash: "x"\n  - id: b\n    prompt: "uses $a.output"`));
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.message.includes('not an upstream dependency'))).toBe(true);
  });

  test('no such warning when the dependency is declared', () => {
    const res = v(doc(`  - id: a\n    bash: "x"\n  - id: b\n    prompt: "uses $a.output"\n    depends_on: [a]`));
    expect(res.warnings.some((w) => w.message.includes('not an upstream dependency'))).toBe(false);
  });

  test('accepts a transitive ancestor reference', () => {
    const res = v(
      doc(`  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]\n  - id: c\n    prompt: "$a.output"\n    depends_on: [b]`),
    );
    expect(res.warnings.some((w) => w.message.includes('not an upstream dependency'))).toBe(false);
  });

  test('warns on field access against a node with no output_format', () => {
    const res = v(
      doc(`  - id: a\n    prompt: "x"\n  - id: b\n    prompt: "$a.output.kind"\n    depends_on: [a]`),
    );
    expect(res.warnings.some((w) => w.message.includes('declares no output_format'))).toBe(true);
  });

  test('no such warning when output_format is declared', () => {
    const yaml = doc(
      `  - id: a\n    prompt: "x"\n    output_format:\n      type: object\n      properties:\n        kind:\n          type: string\n  - id: b\n    prompt: "$a.output.kind"\n    depends_on: [a]`,
    );
    expect(v(yaml).warnings.some((w) => w.message.includes('declares no output_format'))).toBe(false);
  });

  test('flags an unparseable when expression', () => {
    const res = v(doc(`  - id: a\n    bash: x\n  - id: b\n    bash: y\n    depends_on: [a]\n    when: "garbage"`));
    expect(res.errors.some((e) => e.message.includes('invalid when expression'))).toBe(true);
  });

  test('checks references inside when expressions', () => {
    const res = v(doc(`  - id: a\n    bash: x\n    when: "$nope.output == 'y'"`));
    expect(res.errors.some((e) => e.message.includes("unknown node '$nope.output'"))).toBe(true);
  });

  test('checks references inside approval and cancel bodies', () => {
    const approval = v(doc(`  - id: g\n    approval:\n      message: "review $ghost.output"`));
    expect(approval.errors.some((e) => e.message.includes('$ghost.output'))).toBe(true);
    const cancel = v(doc(`  - id: x\n    cancel: "stop because $ghost.output"`));
    expect(cancel.errors.some((e) => e.message.includes('$ghost.output'))).toBe(true);
  });

  test('resolveCommand reports missing command files', () => {
    const { workflow } = load(doc(`  - id: c\n    command: code-review-agent`));
    const missing = validateWorkflow(workflow, { resolveCommand: () => null });
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]!.message).toContain("command 'code-review-agent' was not found");

    const found = validateWorkflow(workflow, { resolveCommand: () => '/cmds/x.md' });
    expect(found.ok).toBe(true);
  });
});

describe('discoverWorkflowFiles', () => {
  test('finds yaml at the top level and one folder deep, sorted', () => {
    const root = mkdtempSync(join(tmpdir(), 'gaggle-wf-'));
    try {
      mkdirSync(join(root, 'gaggle'), { recursive: true });
      writeFileSync(join(root, 'b.yaml'), 'name: b');
      writeFileSync(join(root, 'a.yml'), 'name: a');
      writeFileSync(join(root, 'notes.md'), 'ignored');
      writeFileSync(join(root, 'gaggle', 'nested.yaml'), 'name: n');
      const found = discoverWorkflowFiles(root).map((p) => p.replace(root, '').replace(/\\/g, '/'));
      expect(found).toEqual(['/a.yml', '/b.yaml', '/gaggle/nested.yaml']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns empty for a missing directory', () => {
    expect(discoverWorkflowFiles(join(tmpdir(), 'definitely-not-here-xyz'))).toEqual([]);
  });
});

describe('the shipped workflow templates', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaggle-tpl-'));

  for (const [filename, content] of Object.entries(TEMPLATES)) {
    test(`${filename} loads and validates clean`, () => {
      const path = join(root, filename);
      writeFileSync(path, content);
      const { workflow, warnings } = loadWorkflowFile(path);

      expect(workflow.nodes.length).toBeGreaterThan(0);
      // Command resolution is exercised in phase 7; the bundled library does
      // not exist yet, so resolveCommand is deliberately omitted here.
      const res = validateWorkflow(workflow);
      const detail = res.errors.map((e) => `${e.node_id ?? '-'}: ${e.message}`).join('\n');
      expect(detail).toBe('');
      expect(res.ok).toBe(true);

      // Warnings are tolerable, but never a dangling reference.
      expect(warnings.every((w) => !w.message.includes('unknown node'))).toBe(true);
    });
  }

  test('the .archon workflow in this repo still loads', () => {
    const res = loadWorkflowFile('.archon/workflows/generate-gaggle-md.yaml');
    expect(res.workflow.name).toBe('generate-gaggle-md');
    expect(validateWorkflow(res.workflow).ok).toBe(true);
  });
});
