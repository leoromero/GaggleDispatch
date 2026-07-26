/**
 * The Claude adapter's testable surface, and the ExecutorClient.
 *
 * `claudeRunner` itself drives the Agent SDK, so the engine tests it through a
 * stub. That leaves two pieces genuinely untested until now: the auth
 * resolution that decides how the subprocess authenticates, and the JSON
 * extraction that turns a model's answer into `$node.output.field`. Both are
 * pure, both have real branching, and both fail silently when wrong — a bad
 * auth resolution surfaces as a confusing SDK error deep in a run.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildClaudeEnv, extractJson } from '../executor/engine/provider/claude.ts';
import { ExecutorClient, findRunForRepo } from '../executor/client.ts';
import { GaggleExecutor } from '../executor/engine/index.ts';
import { MemoryStore } from '../executor/store/memory.ts';
import type { AiResult } from '../executor/engine/provider/claude.ts';
import type { RunRecord } from '../executor/types.ts';

// ── auth resolution ─────────────────────────────────────────────────────────

describe('buildClaudeEnv', () => {
  /** A base env with every Claude-related key cleared. */
  const clean = (over: Record<string, string> = {}) => {
    const saved = { ...process.env };
    for (const k of [
      'CLAUDE_API_KEY',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_USE_GLOBAL_AUTH',
    ]) {
      delete process.env[k];
    }
    const result = buildClaudeEnv(over);
    process.env = saved;
    return result;
  };

  test('an explicit CLAUDE_API_KEY is mirrored to ANTHROPIC_API_KEY', () => {
    // The SDK and the raw client read different names; setting one and not the
    // other is a confusing half-configured state.
    const env = clean({ CLAUDE_API_KEY: 'sk-explicit' });
    expect(env.CLAUDE_API_KEY).toBe('sk-explicit');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-explicit');
    expect(env.CLAUDE_USE_GLOBAL_AUTH).toBeUndefined();
  });

  test('ANTHROPIC_API_KEY alone is accepted as the key', () => {
    const env = clean({ ANTHROPIC_API_KEY: 'sk-anthropic' });
    expect(env.CLAUDE_API_KEY).toBe('sk-anthropic');
  });

  test('an OAuth token suppresses the global-auth fallback', () => {
    const env = clean({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
    expect(env.CLAUDE_USE_GLOBAL_AUTH).toBeUndefined();
    expect(env.CLAUDE_API_KEY).toBeUndefined();
  });

  test('with no credentials at all it falls back to the `claude /login` session', () => {
    expect(clean().CLAUDE_USE_GLOBAL_AUTH).toBe('true');
  });

  test('an explicit CLAUDE_USE_GLOBAL_AUTH=false is not overwritten', () => {
    expect(clean({ CLAUDE_USE_GLOBAL_AUTH: 'false' }).CLAUDE_USE_GLOBAL_AUTH).toBe('false');
  });

  test('caller-supplied env wins over the ambient process env', () => {
    process.env.CLAUDE_API_KEY = 'sk-ambient';
    try {
      expect(buildClaudeEnv({ CLAUDE_API_KEY: 'sk-caller' }).CLAUDE_API_KEY).toBe('sk-caller');
    } finally {
      delete process.env.CLAUDE_API_KEY;
    }
  });

  test('unrelated process env is passed through', () => {
    process.env.GAGGLE_PROBE_VALUE = 'kept';
    try {
      expect(buildClaudeEnv().GAGGLE_PROBE_VALUE).toBe('kept');
    } finally {
      delete process.env.GAGGLE_PROBE_VALUE;
    }
  });
});

// ── structured output extraction ────────────────────────────────────────────

describe('extractJson', () => {
  test('parses a bare JSON object', () => {
    expect(extractJson('{"issue_type":"bug"}')).toEqual({ issue_type: 'bug' });
  });

  test('parses a fenced block, with or without a language tag', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  test('digs the object out of surrounding prose', () => {
    // Models narrate. `$node.output.field` has to keep working when they do.
    expect(extractJson('Here is my answer:\n{"a":3}\nHope that helps!')).toEqual({ a: 3 });
  });

  test('tolerates leading and trailing whitespace', () => {
    expect(extractJson('\n\n  {"a":4}  \n')).toEqual({ a: 4 });
  });

  test('handles nested braces rather than stopping at the first close', () => {
    expect(extractJson('prose {"a":{"b":5}} more')).toEqual({ a: { b: 5 } });
  });

  test('returns undefined rather than throwing on unparseable text', () => {
    expect(extractJson('no json here at all')).toBeUndefined();
    expect(extractJson('{ this is not valid json }')).toBeUndefined();
    expect(extractJson('')).toBeUndefined();
  });
});

// ── the client the orchestrator calls ───────────────────────────────────────

describe('findRunForRepo', () => {
  const run = (over: Partial<RunRecord>): RunRecord => ({
    id: randomUUID(),
    workflow_name: 'w',
    user_message: 'm',
    status: 'running',
    working_path: '/repos/trialmatch-be',
    started_at: new Date().toISOString(),
    completed_at: null,
    last_activity_at: null,
    metadata: {},
    ...over,
  });

  test('matches on a path substring, case-insensitively', () => {
    const hit = run({ working_path: '/repos/TrialMatch-BE/worktrees/x' });
    expect(findRunForRepo([hit], 'trialmatch-be', ['running'])?.id).toBe(hit.id);
  });

  test('ignores runs whose status is not requested', () => {
    expect(findRunForRepo([run({ status: 'completed' })], 'trialmatch-be', ['running'])).toBeNull();
  });

  test('ignores runs with no working path', () => {
    expect(findRunForRepo([run({ working_path: null })], 'trialmatch-be', ['running'])).toBeNull();
  });

  test('returns the most recent match', () => {
    const older = run({ started_at: new Date(Date.now() - 60_000).toISOString() });
    const newer = run({ started_at: new Date().toISOString() });
    expect(findRunForRepo([older, newer], 'trialmatch-be', ['running'])?.id).toBe(newer.id);
  });

  test('returns null when nothing matches', () => {
    expect(findRunForRepo([], 'x', ['running'])).toBeNull();
    expect(findRunForRepo([run({})], 'other-repo', ['running'])).toBeNull();
  });
});

describe('ExecutorClient', () => {
  let repo: string;
  let store: MemoryStore;
  let exec: GaggleExecutor;
  let client: ExecutorClient;

  const ok: AiResult = {
    text: 'ok', sessionId: null, inputTokens: 0, outputTokens: 0, timedOut: false, cancelled: false,
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gaggle-client-'));
    mkdirSync(join(repo, '.gaggle', 'workflows'), { recursive: true });
    store = new MemoryStore();
    exec = new GaggleExecutor({
      store,
      artifactsRoot: join(repo, '.artifacts'),
      ai: async () => ok,
    });
    client = new ExecutorClient(exec, store);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const write = (name: string, yaml: string) =>
    writeFileSync(join(repo, '.gaggle', 'workflows', `${name}.yaml`), yaml);

  test('getRunDetail returns the run alongside its event trail', async () => {
    write('simple', 'name: simple\ndescription: d\nnodes:\n  - id: a\n    prompt: "x"\n');
    const handle = await exec.startRun({ workflow: 'simple', cwd: repo, message: 'm' }, () => {});
    await handle.done;

    const detail = await client.getRunDetail(handle.run_id);
    expect(detail?.run.id).toBe(handle.run_id);
    expect(detail!.events.map((e) => e.event_type)).toContain('run_completed');
  });

  test('getRunDetail returns null for an unknown run rather than throwing', async () => {
    expect(await client.getRunDetail(randomUUID())).toBeNull();
  });

  test('listRuns filters by status', async () => {
    write('simple', 'name: simple\ndescription: d\nnodes:\n  - id: a\n    prompt: "x"\n');
    const handle = await exec.startRun({ workflow: 'simple', cwd: repo, message: 'm' }, () => {});
    await handle.done;

    expect((await client.listRuns(['completed'])).map((r) => r.id)).toEqual([handle.run_id]);
    expect(await client.listRuns(['paused'])).toEqual([]);
    expect(await client.listRuns()).toHaveLength(1);
  });

  test('approveRun reports false when there is no gate to approve', async () => {
    // The orchestrator can race a decision against a run that already moved
    // on; that must be a no-op, not an error.
    write('simple', 'name: simple\ndescription: d\nnodes:\n  - id: a\n    prompt: "x"\n');
    const handle = await exec.startRun({ workflow: 'simple', cwd: repo, message: 'm' }, () => {});
    await handle.done;
    expect(await client.approveRun(handle.run_id, 'nothing pending')).toBe(false);
  });

  test('approveRun returns true and resumes when a gate is pending', async () => {
    write(
      'gate',
      'name: gate\ndescription: d\nnodes:\n  - id: g\n    approval:\n      message: "ok?"\n  - id: after\n    depends_on: [g]\n    prompt: "go"\n',
    );
    const handle = await exec.startRun({ workflow: 'gate', cwd: repo, message: 'm' }, () => {});
    await handle.done;

    expect(await client.approveRun(handle.run_id, 'yes')).toBe(true);
    await Bun.sleep(200);
    expect((await client.getRun(handle.run_id))?.status).toBe('completed');
  });

  test('abandonRun marks a paused run cancelled', async () => {
    write('gate', 'name: gate\ndescription: d\nnodes:\n  - id: g\n    approval:\n      message: "ok?"\n');
    const handle = await exec.startRun({ workflow: 'gate', cwd: repo, message: 'm' }, () => {});
    await handle.done;

    await client.abandonRun(handle.run_id);
    expect((await client.getRun(handle.run_id))?.status).toBe('cancelled');
  });

  test('approveAndWatch returns null when there is no gate', async () => {
    write('simple', 'name: simple\ndescription: d\nnodes:\n  - id: a\n    prompt: "x"\n');
    const handle = await exec.startRun({ workflow: 'simple', cwd: repo, message: 'm' }, () => {});
    await handle.done;
    expect(await client.approveAndWatch(handle.run_id, 'x', () => {})).toBeNull();
  });

  test('approveAndWatch streams the resumed run’s events', async () => {
    write(
      'gate',
      'name: gate\ndescription: d\nnodes:\n  - id: g\n    approval:\n      message: "ok?"\n  - id: after\n    depends_on: [g]\n    prompt: "go"\n',
    );
    const handle = await exec.startRun({ workflow: 'gate', cwd: repo, message: 'm' }, () => {});
    await handle.done;

    const seen: string[] = [];
    const resumed = await client.approveAndWatch(handle.run_id, 'yes', (e) => seen.push(e.type));
    expect(resumed).not.toBeNull();
    await resumed!.done;

    expect(seen).toContain('run_started');
    expect(seen).toContain('run_succeeded');
  });
});
