/**
 * Git worktree isolation.
 *
 * Replaces `archon isolation`. Worktrees are cut directly from the repo-syncer
 * checkout rather than from a private clone, which removes the second source
 * tree the old integration had to keep workflow templates synced into.
 *
 * Everything git-facing goes through `git()` so failures carry the command and
 * stderr — a bare "exit 128" from deep inside a run is unactionable.
 */

import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../../util/logger.ts';
import type { Store, WorktreeRow } from '../store/types.ts';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitError extends Error {
  constructor(args: string[], result: GitResult) {
    super(`git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr.trim().slice(0, 400)}`);
    this.name = 'GitError';
  }
}

export function git(args: string[], cwd: string, timeoutMs = 60_000): GitResult {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  });
  const dec = new TextDecoder();
  return {
    stdout: dec.decode(proc.stdout ?? new Uint8Array()).trim(),
    stderr: dec.decode(proc.stderr ?? new Uint8Array()).trim(),
    exitCode: proc.exitCode ?? -1,
  };
}

export function gitOrThrow(args: string[], cwd: string, timeoutMs = 60_000): string {
  const res = git(args, cwd, timeoutMs);
  if (res.exitCode !== 0) throw new GitError(args, res);
  return res.stdout;
}

/**
 * Best-effort default branch for a checkout.
 *
 * Prefers the remote's HEAD, since that is what a PR will target; falls back
 * to the currently checked-out branch. Returns null rather than guessing
 * 'main' — `$BASE_BRANCH` throws on null, which is a better failure than
 * branching from a branch that does not exist.
 */
export function detectDefaultBranch(cwd: string): string | null {
  if (!existsSync(join(cwd, '.git'))) return null;

  const remote = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (remote.exitCode === 0 && remote.stdout) {
    const short = remote.stdout.replace(/^origin\//, '');
    if (short) return short;
  }

  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (current.exitCode === 0 && current.stdout && current.stdout !== 'HEAD') return current.stdout;

  return null;
}

/** Slug safe for a filesystem path. */
export function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export interface CreateWorktreeOptions {
  repoPath: string;
  repoSlug: string;
  branch: string;
  /** Where worktree directories live. One subdirectory per repo. */
  worktreesRoot: string;
  baseBranch?: string | null;
  runId?: string | null;
  /** Git-ignored files copied from the checkout into the new worktree. */
  copyFiles?: string[];
  store?: Store;
}

export interface WorktreeHandle {
  path: string;
  branch: string;
  created: boolean;
}

/**
 * Create a worktree, or adopt an existing healthy one for the same branch.
 *
 * Reusing is deliberate: a retry of the same issue should land on the branch
 * that already has the earlier commits, not orphan them on a fresh one.
 */
export async function ensureWorktree(opts: CreateWorktreeOptions): Promise<WorktreeHandle> {
  const dir = join(opts.worktreesRoot, opts.repoSlug, sanitizeBranchForPath(opts.branch));

  if (existsSync(join(dir, '.git'))) {
    logger.info('Reusing existing worktree', { branch: opts.branch, path: dir });
    await recordWorktree(opts, dir);
    return { path: dir, branch: opts.branch, created: false };
  }

  mkdirSync(join(opts.worktreesRoot, opts.repoSlug), { recursive: true });

  const branchExists =
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${opts.branch}`], opts.repoPath)
      .exitCode === 0;

  const args = branchExists
    ? ['worktree', 'add', dir, opts.branch]
    : ['worktree', 'add', '-b', opts.branch, dir, ...(opts.baseBranch ? [opts.baseBranch] : [])];

  gitOrThrow(args, opts.repoPath, 120_000);
  logger.info('Created worktree', { branch: opts.branch, path: dir, base: opts.baseBranch ?? null });

  for (const rel of opts.copyFiles ?? []) {
    const from = join(opts.repoPath, rel);
    if (!existsSync(from)) continue;
    try {
      copyFileSync(from, join(dir, rel));
    } catch (err) {
      // Non-fatal: a missing .env is a worse surprise than a loud failure here,
      // but it should not abort a run that may not need it.
      logger.warn('Could not copy file into worktree', { file: rel, error: (err as Error).message });
    }
  }

  await recordWorktree(opts, dir);
  return { path: dir, branch: opts.branch, created: true };
}

async function recordWorktree(opts: CreateWorktreeOptions, path: string): Promise<void> {
  if (!opts.store) return;
  await opts.store.upsertWorktree({
    id: randomUUID(),
    repo_slug: opts.repoSlug,
    branch: opts.branch,
    path,
    base_branch: opts.baseBranch ?? null,
    run_id: opts.runId ?? null,
  });
}

export interface RemoveWorktreeOptions {
  repoPath: string;
  repoSlug: string;
  branch: string;
  path: string;
  /** Remove even with uncommitted changes. */
  force?: boolean;
  /** Also delete the local branch. */
  deleteBranch?: boolean;
  store?: Store;
}

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  const args = ['worktree', 'remove', opts.path];
  if (opts.force) args.push('--force');
  const res = git(args, opts.repoPath, 60_000);
  if (res.exitCode !== 0 && !res.stderr.includes('is not a working tree')) {
    throw new GitError(args, res);
  }
  // Prunes the administrative entry when the directory was deleted by hand.
  git(['worktree', 'prune'], opts.repoPath);

  if (opts.deleteBranch) {
    const del = git(['branch', '-D', opts.branch], opts.repoPath);
    if (del.exitCode !== 0) {
      logger.debug('Branch delete skipped', { branch: opts.branch, stderr: del.stderr });
    }
  }
  await opts.store?.deleteWorktree(opts.repoSlug, opts.branch);
}

export interface WorktreeListing {
  branch: string;
  path: string;
  repo_slug: string;
  age_days: number;
  /** False when the recorded path no longer exists on disk. */
  present: boolean;
}

/**
 * Worktrees this executor knows about, reconciled against the filesystem.
 *
 * Replaces parsing the text output of `archon isolation list`.
 */
export async function listWorktrees(store: Store, repoSlug?: string): Promise<WorktreeListing[]> {
  const rows: WorktreeRow[] = await store.listWorktrees(repoSlug);
  const now = Date.now();
  return rows.map((r) => ({
    branch: r.branch,
    path: r.path,
    repo_slug: r.repo_slug,
    age_days: Math.floor((now - Date.parse(r.last_activity_at)) / 86_400_000),
    present: existsSync(r.path),
  }));
}

/** Branch name a run should use when the caller did not supply one. */
export function defaultBranchNameFor(workflowName: string, seed: string): string {
  const slug = workflowName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${slug}-${seed}`;
}

/** Repo slug from a checkout path, for keying worktrees. */
export function repoSlugFromPath(repoPath: string): string {
  return basename(resolve(repoPath));
}
