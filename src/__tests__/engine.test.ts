/**
 * End-to-end engine behaviour, driven through the public WorkflowExecutor
 * interface with a stubbed model.
 *
 * No API key, no network: the AiRunner is a function, so a stub gives full
 * coverage of graph semantics, gates, loops and resume at unit-test speed.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../executor/store/memory.ts';
import { GaggleExecutor, WorkflowChangedError } from '../executor/engine/index.ts';
import type { AiRequest, AiResult, AiRunner } from '../executor/engine/provider/claude.ts';
import type { RunEvent } from '../executor/types.ts';
import { resolveBashPath } from '../executor/engine/shell.ts';

const BASH = resolveBashPath();
const ifBash = BASH ? test : test.skip;

let repo: string;
let artifacts: string;
let store: MemoryStore;

/** Prompts the stub saw, in order — lets tests assert on substitution. */
let seen: AiRequest[] = [];

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gaggle-eng-'));
  artifacts = join(repo, '.artifacts');
  mkdirSync(join(repo, '.gaggle', 'workflows'), { recursive: true });
  store = new MemoryStore();
  seen = [];
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** A stub model: replies are chosen by the first matching predicate. */
function stubAi(replies: Array<{ when: (p: string) => boolean; reply: Partial<AiResult> }>): AiRunner {
  return async (req) => {
    seen.push(req);
    const hit = replies.find((r) => r.when(req.prompt));
    return {
      text: '',
      sessionId: 'sess-1',
      inputTokens: 1,
      outputTokens: 1,
      timedOut: false,
      cancelled: false,
      ...(hit?.reply ?? {}),
    } as AiResult;
  };
}

const always = () => true;

function writeWorkflow(name: string, yaml: string): void {
  writeFileSync(join(repo, '.gaggle', 'workflows', `${name}.yaml`), yaml);
}

function makeExecutor(ai: AiRunner): GaggleExecutor {
  return new GaggleExecutor({
    store,
    artifactsRoot: artifacts,
    ai,
    bashPath: BASH ?? undefined,
    config: { bashTimeoutMs: 20_000, nodeIdleTimeoutMs: 20_000, maxParallelNodes: 4 },
  });
}

interface RunOutcome {
  events: RunEvent[];
  runId: string;
}

async function runToCompletion(exec: GaggleExecutor, workflow: string, message = 'do it'): Promise<RunOutcome> {
  const events: RunEvent[] = [];
  const handle = await exec.startRun({ workflow, cwd: repo, message }, (e) => events.push(e));
  await handle.done;
  return { events, runId: handle.run_id };
}

const statusOf = async (exec: GaggleExecutor, runId: string) => (await exec.getRun(runId))!.status;

const nodeMap = async (exec: GaggleExecutor, runId: string) => {
  const nodes = await exec.getNodes(runId);
  return Object.fromEntries(nodes.map((n) => [n.node_id, n]));
};

// ── straight-line execution ─────────────────────────────────────────────────

describe('linear workflows', () => {
  test('runs a single prompt node and completes', async () => {
    writeWorkflow('simple', `name: simple\ndescription: d\nnodes:\n  - id: only\n    prompt: "say hi"`);
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'hello' } }]));
    const { runId, events } = await runToCompletion(exec, 'simple');

    expect(await statusOf(exec, runId)).toBe('completed');
    const nodes = await nodeMap(exec, runId);
    expect(nodes.only!.status).toBe('completed');
    expect(nodes.only!.output).toBe('hello');
    expect(events.map((e) => e.type)).toContain('run_succeeded');
  });

  test('threads output from one node into the next prompt', async () => {
    writeWorkflow(
      'chain',
      `name: chain\ndescription: d\nnodes:\n  - id: first\n    prompt: "start"\n  - id: second\n    depends_on: [first]\n    prompt: "saw $first.output"`,
    );
    const exec = makeExecutor(
      stubAi([
        { when: (p) => p.includes('start'), reply: { text: 'FIRST-OUT' } },
        { when: always, reply: { text: 'done' } },
      ]),
    );
    await runToCompletion(exec, 'chain');
    expect(seen[1]!.prompt).toContain('saw FIRST-OUT');
  });

  test('substitutes the user message', async () => {
    writeWorkflow('msg', `name: msg\ndescription: d\nnodes:\n  - id: a\n    prompt: "task: $USER_MESSAGE"`);
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'ok' } }]));
    await runToCompletion(exec, 'msg', 'fix the login bug');
    expect(seen[0]!.prompt).toContain('task: fix the login bug');
  });

  test('runs independent nodes and records both', async () => {
    writeWorkflow(
      'fan',
      `name: fan\ndescription: d\nnodes:\n  - id: a\n    prompt: "a"\n  - id: b\n    prompt: "b"\n  - id: join\n    depends_on: [a, b]\n    prompt: "$a.output+$b.output"`,
    );
    const exec = makeExecutor(
      stubAi([
        { when: (p) => p.trim() === 'a', reply: { text: 'A' } },
        { when: (p) => p.trim() === 'b', reply: { text: 'B' } },
        { when: always, reply: { text: 'joined' } },
      ]),
    );
    const { runId } = await runToCompletion(exec, 'fan');
    expect(await statusOf(exec, runId)).toBe('completed');
    expect(seen.find((s) => s.prompt.includes('+'))!.prompt).toContain('A+B');
  });
});

// ── conditional routing ─────────────────────────────────────────────────────

describe('conditions and joins', () => {
  const routing = `name: route
description: d
nodes:
  - id: classify
    prompt: "classify"
    output_format:
      type: object
      properties:
        issue_type:
          type: string
      required: [issue_type]
  - id: investigate
    depends_on: [classify]
    when: "$classify.output.issue_type == 'bug'"
    prompt: "investigate"
  - id: plan
    depends_on: [classify]
    when: "$classify.output.issue_type != 'bug'"
    prompt: "plan"
  - id: bridge
    depends_on: [investigate, plan]
    trigger_rule: one_success
    prompt: "bridge"
`;

  test('takes the bug branch and skips the other', async () => {
    writeWorkflow('route', routing);
    const exec = makeExecutor(
      stubAi([
        { when: (p) => p.includes('classify'), reply: { text: '{"issue_type":"bug"}', json: { issue_type: 'bug' } } },
        { when: always, reply: { text: 'ok' } },
      ]),
    );
    const { runId } = await runToCompletion(exec, 'route');
    const nodes = await nodeMap(exec, runId);
    expect(nodes.investigate!.status).toBe('completed');
    expect(nodes.plan!.status).toBe('skipped');
    // one_success releases the join even though a branch was skipped.
    expect(nodes.bridge!.status).toBe('completed');
    expect(await statusOf(exec, runId)).toBe('completed');
  });

  test('takes the feature branch on the other classification', async () => {
    writeWorkflow('route', routing);
    const exec = makeExecutor(
      stubAi([
        {
          when: (p) => p.includes('classify'),
          reply: { text: '{"issue_type":"feature"}', json: { issue_type: 'feature' } },
        },
        { when: always, reply: { text: 'ok' } },
      ]),
    );
    const { runId } = await runToCompletion(exec, 'route');
    const nodes = await nodeMap(exec, runId);
    expect(nodes.investigate!.status).toBe('skipped');
    expect(nodes.plan!.status).toBe('completed');
  });

  test('a skipped branch does not fail the run', async () => {
    writeWorkflow('route', routing);
    const exec = makeExecutor(
      stubAi([
        { when: (p) => p.includes('classify'), reply: { text: '{"issue_type":"bug"}', json: { issue_type: 'bug' } } },
        { when: always, reply: { text: 'ok' } },
      ]),
    );
    const { runId } = await runToCompletion(exec, 'route');
    expect(await statusOf(exec, runId)).toBe('completed');
  });
});

// ── shell nodes ─────────────────────────────────────────────────────────────

describe('bash nodes', () => {
  ifBash('captures stdout and feeds it downstream', async () => {
    writeWorkflow(
      'sh',
      `name: sh\ndescription: d\nnodes:\n  - id: probe\n    bash: "echo BLOCKER"\n  - id: react\n    depends_on: [probe]\n    when: "$probe.output == 'BLOCKER'"\n    prompt: "handle it"`,
    );
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'handled' } }]));
    const { runId } = await runToCompletion(exec, 'sh');
    const nodes = await nodeMap(exec, runId);
    expect(nodes.probe!.output).toBe('BLOCKER');
    expect(nodes.react!.status).toBe('completed');
  });

  ifBash('a failing bash node fails the run', async () => {
    writeWorkflow('shfail', `name: shfail\ndescription: d\nnodes:\n  - id: bad\n    bash: "exit 7"`);
    const exec = makeExecutor(stubAi([]));
    const { runId } = await runToCompletion(exec, 'shfail');
    expect(await statusOf(exec, runId)).toBe('failed');
    const nodes = await nodeMap(exec, runId);
    expect(nodes.bad!.error).toContain('exited 7');
  });

  ifBash('exposes ARTIFACTS_DIR and writes survive into later nodes', async () => {
    writeWorkflow(
      'art',
      `name: art\ndescription: d\nnodes:\n  - id: write\n    bash: |\n      mkdir -p "$ARTIFACTS_DIR"\n      echo findings > "$ARTIFACTS_DIR/notes.txt"\n      echo wrote\n  - id: read\n    depends_on: [write]\n    bash: 'cat "$ARTIFACTS_DIR/notes.txt"'`,
    );
    const exec = makeExecutor(stubAi([]));
    const { runId } = await runToCompletion(exec, 'art');
    const nodes = await nodeMap(exec, runId);
    expect(nodes.read!.output).toBe('findings');
  });

  ifBash('shell-quotes node output injected into a script', async () => {
    writeWorkflow(
      'inject',
      `name: inject\ndescription: d\nnodes:\n  - id: danger\n    prompt: "produce"\n  - id: use\n    depends_on: [danger]\n    bash: "echo $danger.output"`,
    );
    // If the output were interpolated raw, the semicolon would run a second
    // command and the marker file would appear.
    const marker = join(repo, 'pwned.txt');
    const exec = makeExecutor(
      stubAi([{ when: always, reply: { text: `safe; touch ${marker.replace(/\\/g, '/')}` } }]),
    );
    const { runId } = await runToCompletion(exec, 'inject');
    const nodes = await nodeMap(exec, runId);
    expect(existsSync(marker)).toBe(false);
    expect(nodes.use!.output).toContain('safe;');
  });
});

// ── script nodes ────────────────────────────────────────────────────────────

describe('script nodes', () => {
  test('runs inline bun code and exposes JSON fields downstream', async () => {
    writeWorkflow(
      'script',
      `name: script\ndescription: d\nnodes:\n  - id: calc\n    script: "console.log(JSON.stringify({ count: 3 }))"\n    runtime: bun\n  - id: after\n    depends_on: [calc]\n    when: "$calc.output.count > '2'"\n    prompt: "many"`,
    );
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'ok' } }]));
    const { runId } = await runToCompletion(exec, 'script');
    const nodes = await nodeMap(exec, runId);
    expect(nodes.after!.status).toBe('completed');
  });
});

// ── failures and retries ────────────────────────────────────────────────────

describe('failures', () => {
  test('a model error fails the node and the run', async () => {
    writeWorkflow('err', `name: err\ndescription: d\nnodes:\n  - id: a\n    prompt: "x"`);
    const exec = makeExecutor(stubAi([{ when: always, reply: { error: 'model exploded' } }]));
    const { runId } = await runToCompletion(exec, 'err');
    expect(await statusOf(exec, runId)).toBe('failed');
    expect((await nodeMap(exec, runId)).a!.error).toContain('model exploded');
  });

  test('downstream nodes are skipped after a failure', async () => {
    writeWorkflow(
      'errchain',
      `name: errchain\ndescription: d\nnodes:\n  - id: a\n    prompt: "x"\n  - id: b\n    depends_on: [a]\n    prompt: "y"`,
    );
    const exec = makeExecutor(stubAi([{ when: always, reply: { error: 'boom' } }]));
    const { runId } = await runToCompletion(exec, 'errchain');
    const nodes = await nodeMap(exec, runId);
    expect(nodes.a!.status).toBe('failed');
    expect(nodes.b!.status).toBe('skipped');
  });

  test('retry re-runs a failing node up to max_attempts', async () => {
    writeWorkflow(
      'retry',
      `name: retry\ndescription: d\nnodes:\n  - id: flaky\n    prompt: "try"\n    retry:\n      max_attempts: 3\n      delay_ms: 1000`,
    );
    let calls = 0;
    const exec = makeExecutor(async (req) => {
      seen.push(req);
      calls += 1;
      return calls < 3
        ? ({ text: '', sessionId: null, inputTokens: 0, outputTokens: 0, timedOut: false, cancelled: false, error: 'transient' } as AiResult)
        : ({ text: 'finally', sessionId: null, inputTokens: 0, outputTokens: 0, timedOut: false, cancelled: false } as AiResult);
    });
    const { runId } = await runToCompletion(exec, 'retry');
    expect(calls).toBe(3);
    expect(await statusOf(exec, runId)).toBe('completed');
    expect((await nodeMap(exec, runId)).flaky!.output).toBe('finally');
  }, 20_000);

  test('an at_most_once node is never retried', async () => {
    writeWorkflow(
      'once',
      `name: once\ndescription: d\nnodes:\n  - id: pr\n    prompt: "open pr"\n    side_effects: at_most_once\n    retry:\n      max_attempts: 3\n      delay_ms: 1000`,
    );
    let calls = 0;
    const exec = makeExecutor(async (req) => {
      seen.push(req);
      calls += 1;
      return { text: '', sessionId: null, inputTokens: 0, outputTokens: 0, timedOut: false, cancelled: false, error: 'nope' } as AiResult;
    });
    const { runId } = await runToCompletion(exec, 'once');
    // The whole point of the marker: repeating may not be safe, so retry is
    // refused even though the workflow asked for it.
    expect(calls).toBe(1);
    expect(await statusOf(exec, runId)).toBe('failed');
  });
});

// ── cancel nodes ────────────────────────────────────────────────────────────

describe('cancel nodes', () => {
  ifBash('a guarded cancel stops the run as cancelled, not failed', async () => {
    writeWorkflow(
      'guard',
      `name: guard\ndescription: d\nnodes:\n  - id: check\n    bash: "echo main"\n  - id: stop\n    depends_on: [check]\n    when: "$check.output == 'main'"\n    cancel: "refusing to run on main"\n  - id: work\n    depends_on: [check]\n    when: "$check.output != 'main'"\n    prompt: "work"`,
    );
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'x' } }]));
    const { runId } = await runToCompletion(exec, 'guard');
    const run = (await exec.getRun(runId))!;
    expect(run.status).toBe('cancelled');
    expect(run.metadata.cancel_reason).toContain('refusing to run on main');
  });
});

// ── loops ───────────────────────────────────────────────────────────────────

describe('loop nodes', () => {
  const loopWf = (extra = '') => `name: loop
description: d
nodes:
  - id: impl
    loop:
      prompt: "keep going"
      until: COMPLETE
      max_iterations: 5
${extra}
`;

  test('iterates until the completion signal', async () => {
    writeWorkflow('loop', loopWf());
    let n = 0;
    const exec = makeExecutor(async (req) => {
      seen.push(req);
      n += 1;
      return {
        text: n < 3 ? 'still working' : 'all done <promise>COMPLETE</promise>',
        sessionId: `s${n}`,
        inputTokens: 0, outputTokens: 0, timedOut: false, cancelled: false,
      } as AiResult;
    });
    const { runId } = await runToCompletion(exec, 'loop');
    expect(n).toBe(3);
    expect(await statusOf(exec, runId)).toBe('completed');
    // <promise> tags are stripped from the recorded output.
    expect((await nodeMap(exec, runId)).impl!.output).not.toContain('<promise>');
  });

  test('fails when the iteration budget is exhausted', async () => {
    writeWorkflow('loop', loopWf());
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'not yet' } }]));
    const { runId } = await runToCompletion(exec, 'loop');
    expect(await statusOf(exec, runId)).toBe('failed');
    expect((await nodeMap(exec, runId)).impl!.error).toContain('within 5 iterations');
  });

  test('records every iteration for resume', async () => {
    writeWorkflow('loop', loopWf());
    let n = 0;
    const exec = makeExecutor(async (req) => {
      seen.push(req);
      n += 1;
      return {
        text: n < 2 ? 'working' : '<promise>COMPLETE</promise>',
        sessionId: 's', inputTokens: 0, outputTokens: 0, timedOut: false, cancelled: false,
      } as AiResult;
    });
    const { runId } = await runToCompletion(exec, 'loop');
    const iterations = await store.getLoopIterations(runId, 'impl');
    expect(iterations).toHaveLength(2);
    expect(iterations[1]!.completed).toBe(true);
  });

  ifBash('until_bash can end the loop before the model signals', async () => {
    writeWorkflow('loopbash', `name: loopbash\ndescription: d\nnodes:\n  - id: fix\n    loop:\n      prompt: "fix tests"\n      until: PASS\n      max_iterations: 5\n      until_bash: "exit 0"`);
    let n = 0;
    const exec = makeExecutor(async (req) => {
      seen.push(req);
      n += 1;
      return { text: 'still red', sessionId: 's', inputTokens: 0, outputTokens: 0, timedOut: false, cancelled: false } as AiResult;
    });
    const { runId } = await runToCompletion(exec, 'loopbash');
    expect(n).toBe(1);
    expect(await statusOf(exec, runId)).toBe('completed');
  });

  test('fresh_context does not thread the session between iterations', async () => {
    writeWorkflow('loopfresh', `name: loopfresh\ndescription: d\nnodes:\n  - id: impl\n    loop:\n      prompt: "go"\n      until: DONE\n      max_iterations: 3\n      fresh_context: true`);
    let n = 0;
    const exec = makeExecutor(async (req) => {
      seen.push(req);
      n += 1;
      return {
        text: n < 2 ? 'more' : '<promise>DONE</promise>',
        sessionId: `s${n}`, inputTokens: 0, outputTokens: 0, timedOut: false, cancelled: false,
      } as AiResult;
    });
    await runToCompletion(exec, 'loopfresh');
    expect(seen.every((s) => s.resumeSessionId === undefined)).toBe(true);
  });

  test('without fresh_context the session threads forward', async () => {
    writeWorkflow('loopthread', `name: loopthread\ndescription: d\nnodes:\n  - id: impl\n    loop:\n      prompt: "go"\n      until: DONE\n      max_iterations: 3`);
    let n = 0;
    const exec = makeExecutor(async (req) => {
      seen.push(req);
      n += 1;
      return {
        text: n < 2 ? 'more' : '<promise>DONE</promise>',
        sessionId: `s${n}`, inputTokens: 0, outputTokens: 0, timedOut: false, cancelled: false,
      } as AiResult;
    });
    await runToCompletion(exec, 'loopthread');
    expect(seen[0]!.resumeSessionId).toBeUndefined();
    expect(seen[1]!.resumeSessionId).toBe('s1');
  });
});

// ── approval gates ──────────────────────────────────────────────────────────

describe('approval gates', () => {
  const gateWf = (approvalExtra = '', name = 'gate') => `name: ${name}
description: d
interactive: true
nodes:
  - id: plan
    prompt: "make a plan"
  - id: review
    depends_on: [plan]
    approval:
      message: "Review this plan: $plan.output"
${approvalExtra}
  - id: build
    depends_on: [review]
    prompt: "build it"
`;

  test('pauses at the gate with the message resolved', async () => {
    writeWorkflow('gate', gateWf());
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'THE PLAN' } }]));
    const events: RunEvent[] = [];
    const handle = await exec.startRun({ workflow: 'gate', cwd: repo, message: 'm' }, (e) => events.push(e));
    await handle.done;

    const run = (await exec.getRun(handle.run_id))!;
    expect(run.status).toBe('paused');
    expect(run.metadata.approval?.nodeId).toBe('review');
    expect(run.metadata.approval?.message).toContain('THE PLAN');

    const paused = events.find((e) => e.type === 'run_gate_paused');
    expect(paused).toBeDefined();
    // The downstream node must not have run.
    expect((await nodeMap(exec, handle.run_id)).build).toBeUndefined();
  });

  test('approving resumes and completes the run', async () => {
    writeWorkflow('gate', gateWf());
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'ok' } }]));
    const handle = await exec.startRun({ workflow: 'gate', cwd: repo, message: 'm' }, () => {});
    await handle.done;
    expect(await statusOf(exec, handle.run_id)).toBe('paused');

    await exec.approve(handle.run_id, 'looks good');
    await Bun.sleep(150);

    expect(await statusOf(exec, handle.run_id)).toBe('completed');
    expect((await nodeMap(exec, handle.run_id)).build!.status).toBe('completed');
  });

  test('capture_response makes the comment available downstream', async () => {
    writeWorkflow(
      'gatecap',
      `name: gatecap
description: d
nodes:
  - id: review
    approval:
      message: "ok?"
      capture_response: true
  - id: after
    depends_on: [review]
    prompt: "human said: $review.output"
`,
    );
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'done' } }]));
    const handle = await exec.startRun({ workflow: 'gatecap', cwd: repo, message: 'm' }, () => {});
    await handle.done;
    await exec.approve(handle.run_id, 'use REST not GraphQL');
    await Bun.sleep(150);

    expect(seen.at(-1)!.prompt).toContain('human said: use REST not GraphQL');
  });

  test('without capture_response the comment is not injected', async () => {
    writeWorkflow(
      'gatenocap',
      `name: gatenocap\ndescription: d\nnodes:\n  - id: review\n    approval:\n      message: "ok?"\n  - id: after\n    depends_on: [review]\n    prompt: "said:[$review.output]"`,
    );
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'done' } }]));
    const handle = await exec.startRun({ workflow: 'gatenocap', cwd: repo, message: 'm' }, () => {});
    await handle.done;
    await exec.approve(handle.run_id, 'some comment');
    await Bun.sleep(150);
    expect(seen.at(-1)!.prompt).toContain('said:[]');
  });

  test('rejecting without on_reject cancels the run', async () => {
    writeWorkflow('gate', gateWf());
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'ok' } }]));
    const handle = await exec.startRun({ workflow: 'gate', cwd: repo, message: 'm' }, () => {});
    await handle.done;

    await exec.reject(handle.run_id, 'plan misses tests');
    await Bun.sleep(150);

    const run = (await exec.getRun(handle.run_id))!;
    expect(run.status).toBe('cancelled');
    expect(run.metadata.cancel_reason).toContain('plan misses tests');
  });

  test('rejecting with on_reject reworks and parks at the gate again', async () => {
    writeWorkflow(
      'gaterework',
      gateWf(
        `      on_reject:
        prompt: "revise given: $REJECTION_REASON"
        max_attempts: 3`,
        'gaterework',
      ),
    );
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'revised' } }]));
    const handle = await exec.startRun({ workflow: 'gaterework', cwd: repo, message: 'm' }, () => {});
    await handle.done;

    await exec.reject(handle.run_id, 'needs more detail');
    await Bun.sleep(200);

    // The rework prompt ran with the reason substituted...
    expect(seen.some((s) => s.prompt.includes('revise given: needs more detail'))).toBe(true);
    // ...and the run is parked again rather than cancelled.
    expect(await statusOf(exec, handle.run_id)).toBe('paused');
  });

  test('a gate decision with no pending gate is ignored', async () => {
    writeWorkflow('simple', `name: simple\ndescription: d\nnodes:\n  - id: a\n    prompt: "x"`);
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'ok' } }]));
    const { runId } = await runToCompletion(exec, 'simple');
    await exec.approve(runId, 'nothing to approve');
    expect(await statusOf(exec, runId)).toBe('completed');
  });
});

// ── resume ──────────────────────────────────────────────────────────────────

describe('resume', () => {
  test('a resumed run reuses completed node output instead of re-running', async () => {
    writeWorkflow(
      'res',
      `name: res\ndescription: d\nnodes:\n  - id: a\n    prompt: "step a"\n  - id: b\n    depends_on: [a]\n    prompt: "step b"`,
    );
    let aCalls = 0;
    let bCalls = 0;
    const exec = makeExecutor(async (req) => {
      seen.push(req);
      if (req.prompt.includes('step a')) aCalls += 1;
      let fail = false;
      if (req.prompt.includes('step b')) {
        bCalls += 1;
        fail = bCalls === 1; // b fails once, then succeeds on resume
      }
      return {
        text: fail ? '' : 'ok',
        error: fail ? 'first attempt fails' : undefined,
        sessionId: null, inputTokens: 0, outputTokens: 0, timedOut: false, cancelled: false,
      } as AiResult;
    });

    const { runId } = await runToCompletion(exec, 'res');
    expect(await statusOf(exec, runId)).toBe('failed');
    expect(aCalls).toBe(1);

    const handle = await exec.resumeRun(runId, () => {});
    await handle.done;

    expect(await statusOf(exec, runId)).toBe('completed');
    // 'a' completed the first time, so resume must not have re-run it.
    expect(aCalls).toBe(1);
  });

  test('resume refuses when the workflow changed', async () => {
    writeWorkflow('drift', `name: drift\ndescription: d\nnodes:\n  - id: a\n    prompt: "v1"`);
    const exec = makeExecutor(stubAi([{ when: always, reply: { error: 'fail' } }]));
    const { runId } = await runToCompletion(exec, 'drift');
    expect(await statusOf(exec, runId)).toBe('failed');

    writeWorkflow('drift', `name: drift\ndescription: d\nnodes:\n  - id: a\n    prompt: "v2 — different"`);
    await expect(exec.resumeRun(runId, () => {})).rejects.toThrow(WorkflowChangedError);
  });

  test('force resumes a changed workflow', async () => {
    writeWorkflow('drift2', `name: drift2\ndescription: d\nnodes:\n  - id: a\n    prompt: "v1"`);
    let calls = 0;
    const exec = makeExecutor(async (req) => {
      seen.push(req);
      calls += 1;
      return {
        text: 'ok',
        error: calls === 1 ? 'fail once' : undefined,
        sessionId: null, inputTokens: 0, outputTokens: 0, timedOut: false, cancelled: false,
      } as AiResult;
    });
    const { runId } = await runToCompletion(exec, 'drift2');

    writeWorkflow('drift2', `name: drift2\ndescription: d\nnodes:\n  - id: a\n    prompt: "v2"`);
    const handle = await exec.resumeRun(runId, () => {}, { force: true });
    await handle.done;
    expect(await statusOf(exec, runId)).toBe('completed');
  });
});

// ── cancellation and dry run ────────────────────────────────────────────────

describe('cancellation', () => {
  test('abandon marks a non-terminal run cancelled', async () => {
    writeWorkflow('gate', `name: gate\ndescription: d\nnodes:\n  - id: g\n    approval:\n      message: "ok?"`);
    const exec = makeExecutor(stubAi([]));
    const handle = await exec.startRun({ workflow: 'gate', cwd: repo, message: 'm' }, () => {});
    await handle.done;
    expect(await statusOf(exec, handle.run_id)).toBe('paused');

    await exec.abandon(handle.run_id);
    expect(await statusOf(exec, handle.run_id)).toBe('cancelled');
  });

  test('abandon leaves a finished run alone', async () => {
    writeWorkflow('simple', `name: simple\ndescription: d\nnodes:\n  - id: a\n    prompt: "x"`);
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'ok' } }]));
    const { runId } = await runToCompletion(exec, 'simple');
    await exec.abandon(runId);
    expect(await statusOf(exec, runId)).toBe('completed');
  });
});

describe('dry run', () => {
  test('denies mutating tools to every AI node', async () => {
    writeWorkflow('dry', `name: dry\ndescription: d\nnodes:\n  - id: a\n    prompt: "change things"`);
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'ok' } }]));
    const handle = await exec.startRun(
      { workflow: 'dry', cwd: repo, message: 'm', dry_run: true },
      () => {},
    );
    await handle.done;
    expect(seen[0]!.readOnly).toBe(true);
  });

  test('a normal run does not set readOnly', async () => {
    writeWorkflow('wet', `name: wet\ndescription: d\nnodes:\n  - id: a\n    prompt: "change things"`);
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'ok' } }]));
    await runToCompletion(exec, 'wet');
    expect(seen[0]!.readOnly).toBe(false);
  });
});

// ── events and bookkeeping ──────────────────────────────────────────────────

describe('events', () => {
  test('emits a coherent lifecycle', async () => {
    writeWorkflow(
      'ev',
      `name: ev\ndescription: d\nnodes:\n  - id: a\n    prompt: "x"\n  - id: b\n    depends_on: [a]\n    prompt: "y"`,
    );
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'ok' } }]));
    const { events } = await runToCompletion(exec, 'ev');
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run_started');
    expect(types).toContain('node_started');
    expect(types).toContain('node_completed');
    expect(types.at(-1)).toBe('run_succeeded');
  });

  test('persists an event trail', async () => {
    writeWorkflow('ev2', `name: ev2\ndescription: d\nnodes:\n  - id: a\n    prompt: "x"`);
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'ok' } }]));
    const { runId } = await runToCompletion(exec, 'ev2');
    const stored = (await store.listEvents(runId)).map((e) => e.event_type);
    expect(stored).toContain('run_started');
    expect(stored).toContain('node_completed');
    expect(stored).toContain('run_completed');
  });

  test('an exploding event listener does not take the run down', async () => {
    writeWorkflow('ev3', `name: ev3\ndescription: d\nnodes:\n  - id: a\n    prompt: "x"`);
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'ok' } }]));
    const handle = await exec.startRun({ workflow: 'ev3', cwd: repo, message: 'm' }, () => {
      throw new Error('listener blew up');
    });
    await handle.done;
    expect(await statusOf(exec, handle.run_id)).toBe('completed');
  });

  test('creates the artifacts directory for the run', async () => {
    writeWorkflow('art2', `name: art2\ndescription: d\nnodes:\n  - id: a\n    prompt: "x"`);
    const exec = makeExecutor(stubAi([{ when: always, reply: { text: 'ok' } }]));
    const { runId } = await runToCompletion(exec, 'art2');
    expect(existsSync(join(artifacts, runId))).toBe(true);
  });
});
