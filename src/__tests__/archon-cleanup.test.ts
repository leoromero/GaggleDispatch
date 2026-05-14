/**
 * runStartupArchonCleanup tests.
 *
 * Each test installs stub scripts for `archon` and `gh` into a tmp dir,
 * controls their behaviour via marker files (no env-var threading needed),
 * and asserts on the per-worktree action returned by the cleanup.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIsolationList, runStartupArchonCleanup } from '../executor/archon-cleanup.ts';

let baseDir: string;
let stubDir: string;
let archonStub: string;
let ghStub: string;
let repoA: string;

const isWin = process.platform === 'win32';

/** Behaviours, controlled by sentinel files the stubs read. */
interface StubBehavior {
  isolationListText: string;
  /** map: branch -> 'open' | 'closed' (or absent = no PR ever) */
  prState: Record<string, 'open' | 'closed'>;
  /** map: branch -> 'ok' | 'fail' */
  completeBehavior: Record<string, 'ok' | 'fail'>;
}

function writeStubs(b: StubBehavior): void {
  // Persist the behaviour as JSON so the stubs can read it at runtime.
  writeFileSync(join(stubDir, 'behavior.json'), JSON.stringify(b), 'utf8');

  // Cross-platform stubs: on Windows we write .cmd files that shell out to
  // node/bun to read behaviour. We use a tiny inline bun runner.
  const runnerJs = `
const fs = require('node:fs');
const path = require('node:path');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'behavior.json'), 'utf8'));
const which = process.argv[2];
const rest = process.argv.slice(3);
if (which === 'archon') {
  if (rest[0] === 'isolation' && rest[1] === 'list') {
    process.stdout.write(cfg.isolationListText);
    process.exit(0);
  }
  if (rest[0] === 'complete') {
    const branch = rest[1];
    const beh = cfg.completeBehavior[branch] || 'ok';
    process.exit(beh === 'ok' ? 0 : 1);
  }
}
if (which === 'gh') {
  if (rest[0] === 'pr' && rest[1] === 'list') {
    const headIdx = rest.indexOf('--head');
    const branch = headIdx >= 0 ? rest[headIdx + 1] : '';
    const state = cfg.prState[branch];
    const result = state === 'open' ? [{ url: 'https://gh/pr/1' }] : [];
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  }
}
process.exit(99);
`.trim();

  writeFileSync(join(stubDir, 'runner.cjs'), runnerJs);

  if (isWin) {
    writeFileSync(
      join(stubDir, 'archon.cmd'),
      `@echo off\nnode "${join(stubDir, 'runner.cjs').replace(/\\/g, '\\\\')}" archon %*\n`,
    );
    writeFileSync(
      join(stubDir, 'gh.cmd'),
      `@echo off\nnode "${join(stubDir, 'runner.cjs').replace(/\\/g, '\\\\')}" gh %*\n`,
    );
    archonStub = join(stubDir, 'archon.cmd');
    ghStub = join(stubDir, 'gh.cmd');
  } else {
    const archonSh = `#!/bin/sh\nnode "${join(stubDir, 'runner.cjs')}" archon "$@"\n`;
    const ghSh = `#!/bin/sh\nnode "${join(stubDir, 'runner.cjs')}" gh "$@"\n`;
    writeFileSync(join(stubDir, 'archon'), archonSh);
    writeFileSync(join(stubDir, 'gh'), ghSh);
    chmodSync(join(stubDir, 'archon'), 0o755);
    chmodSync(join(stubDir, 'gh'), 0o755);
    archonStub = join(stubDir, 'archon');
    ghStub = join(stubDir, 'gh');
  }
}

function isolationListText(entries: Array<{ branch: string; age_days: number }>): string {
  const lines = ['git@github:example/repo.git:'];
  for (const e of entries) {
    lines.push(`  ${e.branch}`);
    lines.push(`    Path: /fake/path/${e.branch}`);
    lines.push(`    Type: task | Platform: cli | Last activity: ${e.age_days}d ago`);
  }
  lines.push(`Total: ${entries.length} environment(s)`);
  return lines.join('\n') + '\n';
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'gaggle-cleanup-test-'));
  stubDir = join(baseDir, 'stubs');
  mkdirSync(stubDir);
  repoA = join(baseDir, 'repo-a');
  mkdirSync(repoA);
});

afterEach(() => {
  try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── parseIsolationList ────────────────────────────────────────────────────

describe('parseIsolationList', () => {
  test('extracts branch + path + age', () => {
    const text = `
git@github:example/repo.git:
  archon/task-1
    Path: C:/foo/task-1
    Type: task | Platform: cli | Last activity: 3d ago
  archon/task-2
    Path: C:/foo/task-2
    Type: task | Platform: cli | Last activity: 0d ago

Total: 2 environment(s)
`;
    const out = parseIsolationList(text);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ branch: 'archon/task-1', path: 'C:/foo/task-1', age_days: 3 });
    expect(out[1]).toEqual({ branch: 'archon/task-2', path: 'C:/foo/task-2', age_days: 0 });
  });

  test('returns [] for empty output', () => {
    expect(parseIsolationList('')).toEqual([]);
  });

  test('ignores stray lines without a structured entry', () => {
    expect(parseIsolationList('hello world\n\nTotal: 0\n')).toEqual([]);
  });
});

// ─── runStartupArchonCleanup ───────────────────────────────────────────────

describe('runStartupArchonCleanup', () => {
  test('short-circuits when ageDays is 0', async () => {
    writeStubs({ isolationListText: '', prState: {}, completeBehavior: {} });
    const result = await runStartupArchonCleanup({
      ageDays: 0,
      repos: [{ alias: 'a', cwd: repoA }],
      command: archonStub,
      ghCommand: ghStub,
    });
    expect(result).toEqual([]);
  });

  test('removes an old worktree that has no open PR', async () => {
    writeStubs({
      isolationListText: isolationListText([{ branch: 'archon/task-old', age_days: 30 }]),
      prState: { /* no entry → no open PR */ },
      completeBehavior: { 'archon/task-old': 'ok' },
    });
    const result = await runStartupArchonCleanup({
      ageDays: 7,
      repos: [{ alias: 'a', cwd: repoA }],
      command: archonStub,
      ghCommand: ghStub,
    });
    expect(result[0]?.ok).toBe(true);
    expect(result[0]?.worktrees[0]).toEqual({
      branch: 'archon/task-old',
      action: 'removed',
      detail: 'age=30d',
    });
  });

  test('preserves a worktree whose branch has an OPEN PR (even if old)', async () => {
    writeStubs({
      isolationListText: isolationListText([{ branch: 'archon/task-pr', age_days: 30 }]),
      prState: { 'archon/task-pr': 'open' },
      completeBehavior: {},
    });
    const result = await runStartupArchonCleanup({
      ageDays: 7,
      repos: [{ alias: 'a', cwd: repoA }],
      command: archonStub,
      ghCommand: ghStub,
    });
    expect(result[0]?.worktrees[0]?.action).toBe('preserved_pr_open');
  });

  test('preserves a recent worktree even without an open PR', async () => {
    writeStubs({
      isolationListText: isolationListText([{ branch: 'archon/task-fresh', age_days: 1 }]),
      prState: {},
      completeBehavior: {},
    });
    const result = await runStartupArchonCleanup({
      ageDays: 7,
      repos: [{ alias: 'a', cwd: repoA }],
      command: archonStub,
      ghCommand: ghStub,
    });
    expect(result[0]?.worktrees[0]?.action).toBe('preserved_too_recent');
    expect(result[0]?.worktrees[0]?.detail).toBe('age=1d');
  });

  test('mixed: old-no-PR removed, old-with-PR preserved, fresh preserved', async () => {
    writeStubs({
      isolationListText: isolationListText([
        { branch: 'archon/abandoned', age_days: 30 },
        { branch: 'archon/in-review', age_days: 20 },
        { branch: 'archon/recent-failure', age_days: 0 },
      ]),
      prState: { 'archon/in-review': 'open' },
      completeBehavior: { 'archon/abandoned': 'ok' },
    });
    const result = await runStartupArchonCleanup({
      ageDays: 7,
      repos: [{ alias: 'a', cwd: repoA }],
      command: archonStub,
      ghCommand: ghStub,
    });
    const byBranch = Object.fromEntries(result[0]!.worktrees.map((w) => [w.branch, w.action]));
    expect(byBranch['archon/abandoned']).toBe('removed');
    expect(byBranch['archon/in-review']).toBe('preserved_pr_open');
    expect(byBranch['archon/recent-failure']).toBe('preserved_too_recent');
  });

  test('records a failed `archon complete` invocation as action: failed', async () => {
    writeStubs({
      isolationListText: isolationListText([{ branch: 'archon/broken', age_days: 30 }]),
      prState: {},
      completeBehavior: { 'archon/broken': 'fail' },
    });
    const result = await runStartupArchonCleanup({
      ageDays: 7,
      repos: [{ alias: 'a', cwd: repoA }],
      command: archonStub,
      ghCommand: ghStub,
    });
    expect(result[0]?.ok).toBe(false);
    expect(result[0]?.worktrees[0]?.action).toBe('failed');
  });

  test('skips repos whose cwd does not exist', async () => {
    writeStubs({ isolationListText: '', prState: {}, completeBehavior: {} });
    const result = await runStartupArchonCleanup({
      ageDays: 7,
      repos: [
        { alias: 'present', cwd: repoA },
        { alias: 'missing', cwd: join(baseDir, 'nope') },
      ],
      command: archonStub,
      ghCommand: ghStub,
    });
    expect(result.length).toBe(1);
    expect(result[0]?.alias).toBe('present');
  });
});
