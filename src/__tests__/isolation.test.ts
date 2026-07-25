/**
 * Worktree isolation and the stale-worktree sweep, against real git repos.
 *
 * These create actual repositories in a temp dir — worktree behaviour is
 * exactly the kind of thing a mock would get wrong.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../executor/store/memory.ts';
import {
  defaultBranchNameFor,
  detectDefaultBranch,
  ensureWorktree,
  git,
  gitOrThrow,
  GitError,
  listWorktrees,
  removeWorktree,
  repoSlugFromPath,
  sanitizeBranchForPath,
} from '../executor/engine/isolation.ts';
import { sweepStaleWorktrees } from '../executor/engine/cleanup.ts';

let root: string;
let repoPath: string;
let worktreesRoot: string;
let store: MemoryStore;

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  gitOrThrow(['init', '--initial-branch=main'], path);
  gitOrThrow(['config', 'user.email', 'test@example.com'], path);
  gitOrThrow(['config', 'user.name', 'Test'], path);
  writeFileSync(join(path, 'README.md'), '# test\n');
  gitOrThrow(['add', '.'], path);
  gitOrThrow(['commit', '-m', 'initial'], path);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gaggle-iso-'));
  repoPath = join(root, 'repo');
  worktreesRoot = join(root, 'worktrees');
  initRepo(repoPath);
  store = new MemoryStore();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('git helpers', () => {
  test('gitOrThrow returns stdout on success', () => {
    expect(gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)).toBe('main');
  });

  test('gitOrThrow surfaces the command and stderr on failure', () => {
    try {
      gitOrThrow(['checkout', 'no-such-branch'], repoPath);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GitError);
      expect((e as Error).message).toContain('checkout no-such-branch');
    }
  });

  test('git reports a non-zero exit without throwing', () => {
    expect(git(['rev-parse', '--verify', 'nope'], repoPath).exitCode).not.toBe(0);
  });
});

describe('detectDefaultBranch', () => {
  test('falls back to the checked-out branch when there is no remote', () => {
    expect(detectDefaultBranch(repoPath)).toBe('main');
  });

  test('returns null for a directory that is not a repo', () => {
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    expect(detectDefaultBranch(plain)).toBeNull();
  });

  test('prefers the remote HEAD when one is configured', () => {
    // origin/HEAD is what a PR will target, so it wins over the local branch.
    gitOrThrow(['checkout', '-b', 'feature-x'], repoPath);
    gitOrThrow(['remote', 'add', 'origin', repoPath], repoPath);
    gitOrThrow(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main'], repoPath);
    gitOrThrow(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repoPath);
    expect(detectDefaultBranch(repoPath)).toBe('main');
  });
});

describe('sanitizeBranchForPath', () => {
  test('flattens slashes and strips edge separators', () => {
    expect(sanitizeBranchForPath('fix/issue-42')).toBe('fix-issue-42');
    expect(sanitizeBranchForPath('feat/ADD thing')).toBe('feat-ADD-thing');
    expect(sanitizeBranchForPath('///weird///')).toBe('weird');
  });
});

describe('defaultBranchNameFor', () => {
  test('slugifies the workflow name and appends the seed', () => {
    expect(defaultBranchNameFor('gaggle/gaggle-fix-issue', 'abc123')).toBe(
      'gaggle-gaggle-fix-issue-abc123',
    );
  });
});

describe('repoSlugFromPath', () => {
  test('is the directory basename', () => {
    expect(repoSlugFromPath(repoPath)).toBe('repo');
  });
});

describe('ensureWorktree', () => {
  test('creates a worktree on a new branch from the base', async () => {
    const wt = await ensureWorktree({
      repoPath,
      repoSlug: 'repo',
      branch: 'fix/thing',
      worktreesRoot,
      baseBranch: 'main',
      store,
    });

    expect(wt.created).toBe(true);
    expect(existsSync(join(wt.path, 'README.md'))).toBe(true);
    expect(gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], wt.path)).toBe('fix/thing');
  });

  test('records the worktree in the store', async () => {
    await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/a', worktreesRoot, baseBranch: 'main', store,
    });
    const rows = await store.listWorktrees('repo');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.branch).toBe('fix/a');
    expect(rows[0]!.base_branch).toBe('main');
  });

  test('reuses an existing worktree rather than orphaning its commits', async () => {
    const first = await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/reuse', worktreesRoot, baseBranch: 'main', store,
    });
    writeFileSync(join(first.path, 'work.txt'), 'in progress');
    gitOrThrow(['add', '.'], first.path);
    gitOrThrow(['commit', '-m', 'wip'], first.path);

    const second = await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/reuse', worktreesRoot, baseBranch: 'main', store,
    });

    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    // A retry must land on the branch that already has the earlier commits.
    expect(existsSync(join(second.path, 'work.txt'))).toBe(true);
  });

  test('checks out an existing branch instead of failing', async () => {
    gitOrThrow(['branch', 'existing-branch'], repoPath);
    const wt = await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'existing-branch', worktreesRoot, baseBranch: 'main', store,
    });
    expect(wt.created).toBe(true);
    expect(gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], wt.path)).toBe('existing-branch');
  });

  test('copies git-ignored files listed in copyFiles', async () => {
    writeFileSync(join(repoPath, '.env'), 'SECRET=1');
    const wt = await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/env', worktreesRoot, baseBranch: 'main',
      copyFiles: ['.env'], store,
    });
    expect(readFileSync(join(wt.path, '.env'), 'utf8')).toBe('SECRET=1');
  });

  test('a missing copyFiles entry is not fatal', async () => {
    const wt = await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/noenv', worktreesRoot, baseBranch: 'main',
      copyFiles: ['.env.absent'], store,
    });
    expect(existsSync(wt.path)).toBe(true);
  });

  test('two branches get separate directories', async () => {
    const a = await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/a', worktreesRoot, baseBranch: 'main', store,
    });
    const b = await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/b', worktreesRoot, baseBranch: 'main', store,
    });
    expect(a.path).not.toBe(b.path);
    expect(await store.listWorktrees('repo')).toHaveLength(2);
  });
});

describe('removeWorktree', () => {
  test('removes the directory and the store row', async () => {
    const wt = await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/gone', worktreesRoot, baseBranch: 'main', store,
    });
    await removeWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/gone', path: wt.path, force: true, store,
    });
    expect(existsSync(wt.path)).toBe(false);
    expect(await store.getWorktree('repo', 'fix/gone')).toBeNull();
  });

  test('deleteBranch also drops the local branch', async () => {
    const wt = await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/branchgone', worktreesRoot, baseBranch: 'main', store,
    });
    await removeWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/branchgone', path: wt.path,
      force: true, deleteBranch: true, store,
    });
    expect(git(['rev-parse', '--verify', 'refs/heads/fix/branchgone'], repoPath).exitCode).not.toBe(0);
  });

  test('removing an already-deleted worktree is not an error', async () => {
    const wt = await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/twice', worktreesRoot, baseBranch: 'main', store,
    });
    rmSync(wt.path, { recursive: true, force: true });
    await removeWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/twice', path: wt.path, force: true, store,
    });
    expect(await store.getWorktree('repo', 'fix/twice')).toBeNull();
  });
});

describe('listWorktrees', () => {
  test('reports presence and age', async () => {
    await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/live', worktreesRoot, baseBranch: 'main', store,
    });
    const listing = await listWorktrees(store, 'repo');
    expect(listing).toHaveLength(1);
    expect(listing[0]!.present).toBe(true);
    expect(listing[0]!.age_days).toBe(0);
  });

  test('flags a row whose directory has been deleted', async () => {
    const wt = await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/ghost', worktreesRoot, baseBranch: 'main', store,
    });
    rmSync(wt.path, { recursive: true, force: true });
    expect((await listWorktrees(store, 'repo'))[0]!.present).toBe(false);
  });
});

describe('sweepStaleWorktrees', () => {
  const repos = () => [{ repo_slug: 'repo', repo_path: repoPath }];

  /**
   * Backdate a worktree row so the age threshold can be exercised.
   *
   * Mutates the stored value in place rather than reconstructing the map key —
   * depending on the store's internal key format made this silently insert a
   * duplicate row instead of ageing the existing one.
   */
  async function age(branch: string, days: number): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (store as any).worktrees as Map<string, { branch: string; last_activity_at: string }>;
    let found = false;
    for (const row of rows.values()) {
      if (row.branch === branch) {
        row.last_activity_at = new Date(Date.now() - days * 86_400_000).toISOString();
        found = true;
      }
    }
    if (!found) throw new Error(`no worktree row for branch '${branch}' to age`);
  }

  test('preserves a worktree younger than the threshold', async () => {
    await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/new', worktreesRoot, baseBranch: 'main', store,
    });
    const [res] = await sweepStaleWorktrees({
      store, repos: repos(), ageDays: 7, openPrProbe: async () => false,
    });
    expect(res!.worktrees[0]!.action).toBe('preserved_too_recent');
  });

  test('removes an old worktree with no open PR', async () => {
    const wt = await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/old', worktreesRoot, baseBranch: 'main', store,
    });
    await age('fix/old', 30);
    const [res] = await sweepStaleWorktrees({
      store, repos: repos(), ageDays: 7, openPrProbe: async () => false,
    });
    expect(res!.worktrees[0]!.action).toBe('removed');
    expect(existsSync(wt.path)).toBe(false);
  });

  test('an open PR preserves the worktree regardless of age', async () => {
    await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/inreview', worktreesRoot, baseBranch: 'main', store,
    });
    await age('fix/inreview', 90);
    const [res] = await sweepStaleWorktrees({
      store, repos: repos(), ageDays: 7, openPrProbe: async () => true,
    });
    expect(res!.worktrees[0]!.action).toBe('preserved_pr_open');
  });

  test('an unavailable PR probe preserves rather than deletes', async () => {
    // Being unable to tell must never mean "delete the unreviewed work".
    await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/unknown', worktreesRoot, baseBranch: 'main', store,
    });
    await age('fix/unknown', 90);
    const [res] = await sweepStaleWorktrees({
      store, repos: repos(), ageDays: 7,
      openPrProbe: async () => { throw new Error('gh not installed'); },
    });
    expect(res!.worktrees[0]!.action).toBe('preserved_pr_open');
    expect(res!.worktrees[0]!.detail).toBe('pr_lookup_failed');
  });

  test('prunes a row whose directory is gone, without consulting the PR probe', async () => {
    const wt = await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/vanished', worktreesRoot, baseBranch: 'main', store,
    });
    rmSync(wt.path, { recursive: true, force: true });
    let probed = false;
    const [res] = await sweepStaleWorktrees({
      store, repos: repos(), ageDays: 7,
      openPrProbe: async () => { probed = true; return false; },
    });
    expect(res!.worktrees[0]!.action).toBe('pruned_missing');
    expect(probed).toBe(false);
    expect(await store.getWorktree('repo', 'fix/vanished')).toBeNull();
  });

  test('ageDays of 0 disables the sweep entirely', async () => {
    await ensureWorktree({
      repoPath, repoSlug: 'repo', branch: 'fix/x', worktreesRoot, baseBranch: 'main', store,
    });
    expect(await sweepStaleWorktrees({ store, repos: repos(), ageDays: 0 })).toEqual([]);
  });

  test('skips a repo whose checkout no longer exists', async () => {
    const res = await sweepStaleWorktrees({
      store,
      repos: [{ repo_slug: 'gone', repo_path: join(root, 'not-here') }],
      ageDays: 7,
      openPrProbe: async () => false,
    });
    expect(res).toEqual([]);
  });
});
