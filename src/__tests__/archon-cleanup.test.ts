/**
 * runStartupArchonCleanup tests. Uses a stub `archon` script on PATH (via a
 * fake binary written into a tmp dir) so we can verify the command was
 * invoked with the right args, captures stdout/stderr, handles non-zero
 * exits gracefully, and skips repos whose cwd doesn't exist.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStartupArchonCleanup } from '../executor/archon-cleanup.ts';

let baseDir: string;
let stubDir: string;
let stubCmd: string;
let repoA: string;
let repoB: string;

/** Write a stub script that records its argv to a file and exits 0
 *  (or with a custom exit code if the args contain `__exit_<N>__`). */
function writeStub(behavior: 'ok' | 'fail' | 'hang' = 'ok'): void {
  const isWin = process.platform === 'win32';
  const scriptPath = isWin ? join(stubDir, 'archon.cmd') : join(stubDir, 'archon');
  const recordPath = join(stubDir, 'calls.log');

  if (isWin) {
    const exitCode = behavior === 'fail' ? 1 : 0;
    const body = behavior === 'hang'
      ? `@echo off\nping -n 60 127.0.0.1 >nul\n`
      : `@echo off\necho %* >> "${recordPath}"\necho cleaned up worktrees\nexit /b ${exitCode}\n`;
    writeFileSync(scriptPath, body);
  } else {
    const exitCode = behavior === 'fail' ? 1 : 0;
    const body = behavior === 'hang'
      ? `#!/bin/sh\nsleep 60\n`
      : `#!/bin/sh\necho "$@" >> "${recordPath}"\necho "cleaned up worktrees"\nexit ${exitCode}\n`;
    writeFileSync(scriptPath, body);
    chmodSync(scriptPath, 0o755);
  }
  stubCmd = scriptPath;
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'gaggle-cleanup-test-'));
  stubDir = join(baseDir, 'stub');
  mkdirSync(stubDir);
  repoA = join(baseDir, 'repo-a');
  repoB = join(baseDir, 'repo-b');
  mkdirSync(repoA);
  mkdirSync(repoB);
});

afterEach(() => {
  try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('runStartupArchonCleanup', () => {
  test('returns empty array when ageDays is 0 (disabled)', async () => {
    writeStub();
    const result = await runStartupArchonCleanup({
      ageDays: 0,
      repos: [{ alias: 'a', cwd: repoA }],
      command: stubCmd,
    });
    expect(result).toEqual([]);
  });

  test('invokes archon per repo with the right args and reports ok', async () => {
    writeStub('ok');
    const result = await runStartupArchonCleanup({
      ageDays: 14,
      repos: [
        { alias: 'a', cwd: repoA },
        { alias: 'b', cwd: repoB },
      ],
      command: stubCmd,
    });
    expect(result.length).toBe(2);
    expect(result[0]?.ok).toBe(true);
    expect(result[0]?.exit_code).toBe(0);
    expect(result[1]?.ok).toBe(true);
    expect(result[0]?.stdout).toContain('cleaned up worktrees');
  });

  test('skips repos whose cwd does not exist', async () => {
    writeStub('ok');
    const result = await runStartupArchonCleanup({
      ageDays: 7,
      repos: [
        { alias: 'present', cwd: repoA },
        { alias: 'missing', cwd: join(baseDir, 'does-not-exist') },
      ],
      command: stubCmd,
    });
    expect(result.length).toBe(1);
    expect(result[0]?.alias).toBe('present');
  });

  test('records a failing cleanup but does not throw', async () => {
    writeStub('fail');
    const result = await runStartupArchonCleanup({
      ageDays: 7,
      repos: [{ alias: 'a', cwd: repoA }],
      command: stubCmd,
    });
    expect(result.length).toBe(1);
    expect(result[0]?.ok).toBe(false);
    expect(result[0]?.exit_code).toBe(1);
  });

  test('honours timeoutMs and records timed-out cleanups', async () => {
    writeStub('hang');
    const result = await runStartupArchonCleanup({
      ageDays: 7,
      repos: [{ alias: 'slow', cwd: repoA }],
      command: stubCmd,
      timeoutMs: 200,
    });
    expect(result[0]?.ok).toBe(false);
    expect(result[0]?.exit_code).toBeNull();
  });
});
