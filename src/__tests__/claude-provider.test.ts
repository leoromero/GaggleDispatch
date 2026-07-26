/**
 * The Claude Agent SDK adapter itself.
 *
 * Every other test drives the engine through a stubbed `AiRunner`, which means
 * the real adapter — the only place that translates a workflow node into SDK
 * options — was never exercised. That is exactly where a silent mistake hides:
 * a mis-mapped option does not throw, it just quietly does the wrong thing.
 * `readOnly` is the sharpest case, because dry-run mode's whole promise is that
 * no tool can touch the working tree.
 *
 * The SDK module is mocked, so this needs no API key and no network.
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';

/** Whatever the adapter last handed the SDK. */
let lastCall: { prompt: unknown; options: Record<string, unknown> } | null = null;
/** Messages the fake SDK will yield on the next call. */
let script: unknown[] = [];
/** Set to throw from the generator, simulating an SDK failure. */
let throwAfter: number | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
    lastCall = args;
    return (async function* () {
      let i = 0;
      for (const msg of script) {
        if (throwAfter !== null && i >= throwAfter) throw new Error('sdk exploded');
        i += 1;
        yield msg;
      }
      if (throwAfter !== null && i >= throwAfter) throw new Error('sdk exploded');
    })();
  },
}));

const { claudeRunner } = await import('../executor/engine/provider/claude.ts');

const assistant = (text: string) => ({
  type: 'assistant',
  session_id: 'sess-1',
  message: { content: [{ type: 'text', text }] },
});
const result = (over: Record<string, unknown> = {}) => ({
  type: 'result',
  session_id: 'sess-1',
  usage: { input_tokens: 11, output_tokens: 22 },
  ...over,
});

const base = { prompt: 'do the thing', cwd: '/repo', env: {}, idleTimeoutMs: 5_000 };

beforeEach(() => {
  lastCall = null;
  throwAfter = null;
  script = [assistant('hello'), result()];
});

describe('option mapping', () => {
  test('passes cwd and bypasses permission prompts', async () => {
    await claudeRunner({ ...base });
    expect(lastCall!.options.cwd).toBe('/repo');
    // A run is unattended; a permission prompt would hang it forever.
    expect(lastCall!.options.permissionMode).toBe('bypassPermissions');
  });

  test('forwards the prompt verbatim', async () => {
    await claudeRunner({ ...base, prompt: 'exact text' });
    expect(lastCall!.prompt).toBe('exact text');
  });

  test('model, maxTurns and allowedTools are forwarded when set', async () => {
    await claudeRunner({ ...base, model: 'opus', maxTurns: 7, allowedTools: ['Read', 'Glob'] });
    expect(lastCall!.options.model).toBe('opus');
    expect(lastCall!.options.maxTurns).toBe(7);
    expect(lastCall!.options.allowedTools).toEqual(['Read', 'Glob']);
  });

  test('omitted options are not sent at all', async () => {
    await claudeRunner({ ...base });
    expect('model' in lastCall!.options).toBe(false);
    expect('maxTurns' in lastCall!.options).toBe(false);
    expect('resume' in lastCall!.options).toBe(false);
    expect('disallowedTools' in lastCall!.options).toBe(false);
  });

  test('resumeSessionId becomes the SDK resume option', async () => {
    // This is how `context: shared` threads one node's conversation into the
    // next; if it stopped being passed, every node would silently start cold.
    await claudeRunner({ ...base, resumeSessionId: 'prev-session' });
    expect(lastCall!.options.resume).toBe('prev-session');
  });

  test('output_format is wrapped as a json_schema', async () => {
    const schema = { type: 'object', properties: { issue_type: { type: 'string' } } };
    await claudeRunner({ ...base, outputFormat: schema });
    expect(lastCall!.options.outputFormat).toEqual({ type: 'json_schema', schema });
  });
});

describe('readOnly, the dry-run guarantee', () => {
  test('every mutating tool is denied', async () => {
    await claudeRunner({ ...base, readOnly: true });
    const denied = lastCall!.options.disallowedTools as string[];
    for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash']) {
      expect(denied, `${tool} must be denied in dry-run`).toContain(tool);
    }
  });

  test('a normal run denies nothing', async () => {
    await claudeRunner({ ...base, readOnly: false });
    expect('disallowedTools' in lastCall!.options).toBe(false);
  });

  test('readOnly merges with an explicit deny list without duplicating', async () => {
    await claudeRunner({ ...base, readOnly: true, deniedTools: ['WebFetch', 'Bash'] });
    const denied = lastCall!.options.disallowedTools as string[];
    expect(denied).toContain('WebFetch');
    expect(denied.filter((t) => t === 'Bash')).toHaveLength(1);
  });

  test('deniedTools alone is forwarded', async () => {
    await claudeRunner({ ...base, deniedTools: ['WebFetch'] });
    expect(lastCall!.options.disallowedTools).toEqual(['WebFetch']);
  });
});

describe('result handling', () => {
  test('the last assistant text becomes the node output', async () => {
    script = [assistant('first'), assistant('second'), result()];
    expect((await claudeRunner({ ...base })).text).toBe('second');
  });

  test('streams each chunk to onText while keeping the last as output', async () => {
    script = [assistant('one'), assistant('two'), result()];
    const chunks: string[] = [];
    const r = await claudeRunner({ ...base, onText: (c) => chunks.push(c) });
    expect(chunks).toEqual(['one', 'two']);
    expect(r.text).toBe('two');
  });

  test('captures the session id for a later shared-context node', async () => {
    expect((await claudeRunner({ ...base })).sessionId).toBe('sess-1');
  });

  test('reports token usage from the result message', async () => {
    const r = await claudeRunner({ ...base });
    expect(r.inputTokens).toBe(11);
    expect(r.outputTokens).toBe(22);
  });

  test('json is parsed only when an output_format was requested', async () => {
    script = [assistant('{"k":1}'), result()];
    expect((await claudeRunner({ ...base })).json).toBeUndefined();

    script = [assistant('{"k":1}'), result()];
    const withSchema = await claudeRunner({ ...base, outputFormat: { type: 'object' } });
    expect(withSchema.json).toEqual({ k: 1 });
  });

  test('an is_error result surfaces as an error, not a success', async () => {
    script = [assistant('partial'), result({ is_error: true, errors: ['rate limited'] })];
    const r = await claudeRunner({ ...base });
    expect(r.error).toContain('rate limited');
  });

  test('an is_error with no detail still produces a message', async () => {
    script = [assistant(''), result({ is_error: true, subtype: 'max_turns' })];
    expect((await claudeRunner({ ...base })).error).toContain('max_turns');
  });
});

describe('failure modes', () => {
  test('an SDK throw is reported as an error rather than escaping', async () => {
    // The runner treats a thrown adapter as a crashed run; surfacing the
    // message keeps the failure diagnosable from the node record.
    script = [assistant('x')];
    throwAfter = 1;
    const r = await claudeRunner({ ...base });
    expect(r.error).toContain('sdk exploded');
    expect(r.timedOut).toBe(false);
    expect(r.cancelled).toBe(false);
  });

  test('an external abort is reported as cancelled, not as an error', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await claudeRunner({ ...base, signal: ac.signal });
    expect(r.cancelled).toBe(true);
    expect(r.error).toBeUndefined();
  });

  test('an idle timeout is reported as timed out, not as an error', async () => {
    // A model that stops emitting must not look like a model that failed —
    // the runner retries them differently.
    script = [
      assistant('slow start'),
      // The generator awaits before the next message, past the idle budget.
      new Promise((r) => setTimeout(() => r(result()), 300)) as unknown as object,
    ];
    const r = await claudeRunner({ ...base, idleTimeoutMs: 30 });
    expect(r.timedOut).toBe(true);
    expect(r.error).toBeUndefined();
  });
});
