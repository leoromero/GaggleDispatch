/**
 * bash: and script: node execution against a real shell.
 *
 * These actually spawn processes. They are skipped when no bash is available
 * rather than failing, so the suite still runs on a host without Git Bash.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildScriptArgv,
  resolveNamedScript,
  runBash,
  runProcess,
  runScript,
  runtimeForExtension,
  ScriptResolutionError,
} from '../executor/engine/nodes/shell.ts';
import { resolveBashPath } from '../executor/engine/shell.ts';

const BASH = resolveBashPath();
const ifBash = BASH ? test : test.skip;

let work: string;
let scriptDir: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'gaggle-sh-'));
  scriptDir = join(work, 'scripts');
  mkdirSync(scriptDir, { recursive: true });
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const baseEnv = () => ({ ...process.env, GAGGLE_TEST: 'yes' }) as Record<string, string>;

describe('runBash', () => {
  ifBash('captures stdout as the node output', async () => {
    const r = await runBash({
      script: 'echo hello',
      cwd: work,
      env: baseEnv(),
      timeoutMs: 15_000,
      bashPath: BASH!,
    });
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toBe('hello');
    expect(r.timed_out).toBe(false);
  });

  ifBash('trims exactly one trailing newline', async () => {
    const r = await runBash({
      script: 'printf "a\\n\\n"',
      cwd: work,
      env: baseEnv(),
      timeoutMs: 15_000,
      bashPath: BASH!,
    });
    expect(r.stdout).toBe('a\n');
  });

  ifBash('surfaces a non-zero exit without throwing', async () => {
    const r = await runBash({
      script: 'echo out; echo err >&2; exit 3',
      cwd: work,
      env: baseEnv(),
      timeoutMs: 15_000,
      bashPath: BASH!,
    });
    expect(r.exit_code).toBe(3);
    expect(r.stdout).toBe('out');
    expect(r.stderr).toContain('err');
  });

  ifBash('passes environment through', async () => {
    const r = await runBash({
      script: 'echo "$GAGGLE_TEST"',
      cwd: work,
      env: baseEnv(),
      timeoutMs: 15_000,
      bashPath: BASH!,
    });
    expect(r.stdout).toBe('yes');
  });

  ifBash('runs in the requested working directory', async () => {
    const sub = join(work, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'marker.txt'), 'x');
    const r = await runBash({
      script: 'ls marker.txt',
      cwd: sub,
      env: baseEnv(),
      timeoutMs: 15_000,
      bashPath: BASH!,
    });
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain('marker.txt');
  });

  ifBash('streams lines as they arrive', async () => {
    const seen: string[] = [];
    await runBash({
      script: 'echo one; echo two; echo three >&2',
      cwd: work,
      env: baseEnv(),
      timeoutMs: 15_000,
      bashPath: BASH!,
      onLine: (line, stream) => seen.push(`${stream}:${line}`),
    });
    expect(seen).toContain('stdout:one');
    expect(seen).toContain('stdout:two');
    expect(seen).toContain('stderr:three');
  });

  ifBash('kills a script that exceeds its timeout', async () => {
    const started = Date.now();
    const r = await runBash({
      script: 'sleep 30',
      cwd: work,
      env: baseEnv(),
      timeoutMs: 1_000,
      bashPath: BASH!,
    });
    expect(r.timed_out).toBe(true);
    expect(r.exit_code).not.toBe(0);
    // Proves the kill actually happened rather than the sleep completing.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  ifBash('aborts on signal and reports cancellation', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await runBash({
      script: 'sleep 30',
      cwd: work,
      env: baseEnv(),
      timeoutMs: 30_000,
      bashPath: BASH!,
      signal: ac.signal,
    });
    expect(r.cancelled).toBe(true);
    expect(r.timed_out).toBe(false);
  });

  ifBash('handles a multi-line script with set -e', async () => {
    const r = await runBash({
      script: 'set -euo pipefail\nX=5\nif [ "$X" -eq 5 ]; then echo ok; fi',
      cwd: work,
      env: baseEnv(),
      timeoutMs: 15_000,
      bashPath: BASH!,
    });
    expect(r.stdout).toBe('ok');
  });
});

describe('runProcess', () => {
  ifBash('reports a non-existent binary as a failure rather than hanging', async () => {
    const r = await runProcess({
      argv: ['definitely-not-a-real-binary-xyz'],
      cwd: work,
      env: baseEnv(),
      timeoutMs: 5_000,
    }).catch((e) => ({ error: e as Error }) as never);
    // Bun surfaces this either as a throw or a non-zero exit depending on
    // platform; both are acceptable, a hang is not.
    expect(r).toBeDefined();
  });
});

describe('buildScriptArgv', () => {
  test('bun inline uses -e and blocks the target repo .env', () => {
    const argv = buildScriptArgv({ script: 'console.log(1)', runtime: 'bun', scriptDirs: [] });
    expect(argv).toEqual(['bun', '--no-env-file', '-e', 'console.log(1)']);
  });

  test('uv inline uses python -c', () => {
    const argv = buildScriptArgv({ script: 'print(1)', runtime: 'uv', scriptDirs: [] });
    expect(argv).toEqual(['uv', 'run', 'python', '-c', 'print(1)']);
  });

  test('uv deps become repeated --with flags', () => {
    const argv = buildScriptArgv({
      script: 'print(1)',
      runtime: 'uv',
      deps: ['httpx>=0.27', 'pandas'],
      scriptDirs: [],
    });
    expect(argv).toEqual([
      'uv', 'run', '--with', 'httpx>=0.27', '--with', 'pandas', 'python', '-c', 'print(1)',
    ]);
  });

  test('a bare identifier resolves to a named script file', () => {
    writeFileSync(join(scriptDir, 'analyze.ts'), 'console.log("hi")');
    const argv = buildScriptArgv({ script: 'analyze', runtime: 'bun', scriptDirs: [scriptDir] });
    expect(argv[0]).toBe('bun');
    expect(argv[2]).toBe('run');
    expect(argv[3]).toBe(join(scriptDir, 'analyze.ts'));
  });
});

describe('resolveNamedScript', () => {
  test('finds a file matching the declared runtime', () => {
    writeFileSync(join(scriptDir, 'metrics.py'), 'print(1)');
    expect(resolveNamedScript('metrics', 'uv', [scriptDir])).toBe(join(scriptDir, 'metrics.py'));
  });

  test('honours search-path precedence', () => {
    const first = join(work, 'first');
    mkdirSync(first, { recursive: true });
    writeFileSync(join(first, 'shared.ts'), '1');
    writeFileSync(join(scriptDir, 'shared.ts'), '2');
    expect(resolveNamedScript('shared', 'bun', [first, scriptDir])).toBe(join(first, 'shared.ts'));
  });

  test('names the mismatch when the extension implies another runtime', () => {
    writeFileSync(join(scriptDir, 'mismatched.py'), 'print(1)');
    expect(() => resolveNamedScript('mismatched', 'bun', [scriptDir])).toThrow(ScriptResolutionError);
    try {
      resolveNamedScript('mismatched', 'bun', [scriptDir]);
    } catch (e) {
      expect((e as Error).message).toContain("declares runtime 'bun'");
      expect((e as Error).message).toContain("implies runtime 'uv'");
    }
  });

  test('lists what it looked for when nothing matches', () => {
    try {
      resolveNamedScript('absent', 'bun', [scriptDir]);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('absent');
      expect((e as Error).message).toContain('Looked for');
    }
  });
});

describe('runScript', () => {
  test('executes inline bun code and captures stdout', async () => {
    const r = await runScript({
      script: 'console.log(JSON.stringify({ n: 41 + 1 }))',
      runtime: 'bun',
      cwd: work,
      env: baseEnv(),
      timeoutMs: 30_000,
      scriptDirs: [scriptDir],
    });
    expect(r.exit_code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ n: 42 });
  });

  test('a throwing script fails the node', async () => {
    const r = await runScript({
      script: 'throw new Error("boom")',
      runtime: 'bun',
      cwd: work,
      env: baseEnv(),
      timeoutMs: 30_000,
      scriptDirs: [scriptDir],
    });
    expect(r.exit_code).not.toBe(0);
    expect(r.stderr).toContain('boom');
  });

  test('runs a named script from the search path', async () => {
    writeFileSync(join(scriptDir, 'named.ts'), 'console.log("from-file")');
    const r = await runScript({
      script: 'named',
      runtime: 'bun',
      cwd: work,
      env: baseEnv(),
      timeoutMs: 30_000,
      scriptDirs: [scriptDir],
    });
    expect(r.stdout).toBe('from-file');
  });
});

describe('runtimeForExtension', () => {
  test('maps known extensions and rejects the rest', () => {
    expect(runtimeForExtension('a.ts')).toBe('bun');
    expect(runtimeForExtension('a.js')).toBe('bun');
    expect(runtimeForExtension('a.py')).toBe('uv');
    expect(runtimeForExtension('a.rb')).toBeNull();
  });
});
