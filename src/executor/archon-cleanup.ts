/**
 * Startup-time sweep of stale Archon worktrees.
 *
 * Policy (in priority order, applied per worktree):
 *
 *   1. If `gh pr list --head <branch> --state open` returns any rows,
 *      the worktree backs an in-review PR — PRESERVE.
 *   2. If the worktree's "Last activity" is younger than the configured
 *      threshold (days), PRESERVE.
 *   3. Otherwise call `archon complete <branch>` to remove the worktree
 *      and its branches.
 *
 * The per-run `after_run` hook (`archon isolation cleanup --merged`)
 * continues to handle merged-branch cleanup continuously. This module
 * targets the long tail: abandoned, cancelled, and orphaned worktrees
 * — without touching anything whose PR is still open.
 *
 * Best-effort: every error path logs and continues. Never throws.
 */

import { existsSync } from 'node:fs';
import { logger } from '../util/logger.ts';

export interface RepoCleanupTarget {
  alias: string;
  cwd: string;
}

export interface WorktreeInfo {
  branch: string;
  path: string;
  age_days: number;
}

export interface PerWorktreeResult {
  branch: string;
  action: 'preserved_pr_open' | 'preserved_too_recent' | 'removed' | 'failed';
  detail?: string;
}

export interface RepoCleanupResult {
  alias: string;
  cwd: string;
  ok: boolean;
  reason?: string;
  worktrees: PerWorktreeResult[];
}

/**
 * Sweep stale Archon worktrees across the given repos, respecting open PRs.
 */
export async function runStartupArchonCleanup(args: {
  ageDays: number;
  repos: RepoCleanupTarget[];
  command?: string;
  ghCommand?: string;
  timeoutMs?: number;
}): Promise<RepoCleanupResult[]> {
  if (args.ageDays <= 0) return [];
  const archonCmd = args.command ?? 'archon';
  const ghCmd = args.ghCommand ?? 'gh';
  const timeoutMs = args.timeoutMs ?? 30_000;
  const results: RepoCleanupResult[] = [];

  for (const repo of args.repos) {
    if (!existsSync(repo.cwd)) {
      logger.debug('Skipping cleanup for unsynced repo', { alias: repo.alias, cwd: repo.cwd });
      continue;
    }

    let worktrees: WorktreeInfo[];
    try {
      worktrees = await listArchonWorktrees({ archonCmd, cwd: repo.cwd, timeoutMs });
    } catch (err) {
      logger.warn('Archon worktree listing failed (skipping repo)', {
        alias: repo.alias,
        error: (err as Error).message,
      });
      results.push({ alias: repo.alias, cwd: repo.cwd, ok: false, reason: 'list_failed', worktrees: [] });
      continue;
    }

    const perTree: PerWorktreeResult[] = [];

    for (const wt of worktrees) {
      if (wt.age_days < args.ageDays) {
        perTree.push({ branch: wt.branch, action: 'preserved_too_recent', detail: `age=${wt.age_days}d` });
        continue;
      }

      let prOpen: boolean;
      try {
        prOpen = await hasOpenPR({ ghCmd, branch: wt.branch, cwd: repo.cwd, timeoutMs });
      } catch (err) {
        // Conservative: if we can't determine PR status, treat as "might exist"
        // and preserve the worktree rather than risk deleting unreviewed work.
        logger.warn('gh pr lookup failed; preserving worktree to be safe', {
          alias: repo.alias, branch: wt.branch, error: (err as Error).message,
        });
        perTree.push({ branch: wt.branch, action: 'preserved_pr_open', detail: 'gh_lookup_failed' });
        continue;
      }

      if (prOpen) {
        perTree.push({ branch: wt.branch, action: 'preserved_pr_open' });
        continue;
      }

      const removed = await archonComplete({ archonCmd, branch: wt.branch, cwd: repo.cwd, timeoutMs });
      if (removed.ok) {
        perTree.push({ branch: wt.branch, action: 'removed', detail: `age=${wt.age_days}d` });
      } else {
        perTree.push({ branch: wt.branch, action: 'failed', detail: removed.error });
      }
    }

    const removedCount = perTree.filter((p) => p.action === 'removed').length;
    const preservedPr = perTree.filter((p) => p.action === 'preserved_pr_open').length;
    const preservedRecent = perTree.filter((p) => p.action === 'preserved_too_recent').length;
    const failed = perTree.filter((p) => p.action === 'failed').length;

    logger.info('Archon worktree cleanup pass complete', {
      alias: repo.alias,
      age_days: args.ageDays,
      total: worktrees.length,
      removed: removedCount,
      preserved_pr_open: preservedPr,
      preserved_too_recent: preservedRecent,
      failed,
    });

    results.push({
      alias: repo.alias,
      cwd: repo.cwd,
      ok: failed === 0,
      worktrees: perTree,
    });
  }

  return results;
}

// ─── helpers ────────────────────────────────────────────────────────────

/** Parse the text output of `archon isolation list` into WorktreeInfo[]. */
export function parseIsolationList(text: string): WorktreeInfo[] {
  // Output format (per worktree):
  //
  //   <repo url>:
  //     <branch>
  //       Path: <path>
  //       Type: task | Platform: cli | Last activity: <N>d ago
  //
  const out: WorktreeInfo[] = [];
  const lines = text.split(/\r?\n/);
  let current: Partial<WorktreeInfo> | null = null;

  const pushCurrent = () => {
    if (current?.branch !== undefined && current.path !== undefined && current.age_days !== undefined) {
      out.push(current as WorktreeInfo);
    }
    current = null;
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    // Branch lines are indented by 2 spaces and don't contain Path/Type/Last
    // markers.
    if (/^  \S/.test(line) && !/^\s*(Path:|Type:|Last activity:)/.test(line)) {
      pushCurrent();
      current = { branch: line.trim() };
      continue;
    }
    if (current && line.includes('Path:')) {
      const m = line.match(/Path:\s*(.+)/);
      if (m) current.path = m[1]!.trim();
    }
    if (current && line.includes('Last activity:')) {
      const m = line.match(/Last activity:\s*(\d+)d/);
      current.age_days = m ? parseInt(m[1]!, 10) : 0;
    }
  }
  pushCurrent();
  return out;
}

async function listArchonWorktrees(args: {
  archonCmd: string;
  cwd: string;
  timeoutMs: number;
}): Promise<WorktreeInfo[]> {
  const { stdout, exitCode } = await runWithTimeout({
    cmd: [args.archonCmd, 'isolation', 'list'],
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
  });
  if (exitCode !== 0) {
    throw new Error(`archon isolation list exited ${exitCode}`);
  }
  return parseIsolationList(stdout);
}

async function hasOpenPR(args: {
  ghCmd: string;
  branch: string;
  cwd: string;
  timeoutMs: number;
}): Promise<boolean> {
  const { stdout, exitCode } = await runWithTimeout({
    cmd: [args.ghCmd, 'pr', 'list', '--head', args.branch, '--state', 'open', '--json', 'url', '--limit', '1'],
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
  });
  if (exitCode !== 0) {
    throw new Error(`gh pr list exited ${exitCode}`);
  }
  try {
    const parsed = JSON.parse(stdout.trim() || '[]') as unknown[];
    return Array.isArray(parsed) && parsed.length > 0;
  } catch (err) {
    throw new Error(`gh pr list returned malformed JSON: ${(err as Error).message}`);
  }
}

async function archonComplete(args: {
  archonCmd: string;
  branch: string;
  cwd: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const { exitCode, stderr } = await runWithTimeout({
      cmd: [args.archonCmd, 'complete', args.branch],
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
    });
    if (exitCode === 0) return { ok: true };
    return { ok: false, error: `exit_${exitCode}: ${stderr.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function runWithTimeout(args: {
  cmd: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(args.cmd, {
    cwd: args.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const TIMEOUT = Symbol('timeout');
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), args.timeoutMs);
  });
  const finished = await Promise.race([proc.exited, timeoutPromise]);
  if (timer) clearTimeout(timer);
  if (finished === TIMEOUT) {
    try { proc.kill(); } catch { /* ignore */ }
    throw new Error(`Command timed out after ${args.timeoutMs}ms: ${args.cmd.join(' ')}`);
  }
  const [stdoutTxt, stderrTxt] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  return { stdout: stdoutTxt, stderr: stderrTxt, exitCode: finished as number };
}
