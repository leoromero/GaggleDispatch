/**
 * Stale worktree sweep.
 *
 * Carries over the policy that was proven in the Archon integration, in
 * priority order per worktree:
 *
 *   1. a branch backing an open PR is preserved, always
 *   2. a worktree younger than the age threshold is preserved
 *   3. otherwise it is removed
 *
 * The one behavioural change is where the inventory comes from: the store,
 * rather than parsing the indented text output of `archon isolation list`.
 *
 * Best effort throughout — a cleanup pass that throws would take the
 * orchestrator down at startup for no good reason.
 */

import { existsSync } from 'node:fs';
import { logger } from '../../util/logger.ts';
import type { Store } from '../store/types.ts';
import { listWorktrees, removeWorktree, type WorktreeListing } from './isolation.ts';

export type CleanupAction =
  | 'preserved_pr_open'
  | 'preserved_too_recent'
  | 'removed'
  | 'pruned_missing'
  | 'failed';

export interface PerWorktreeResult {
  branch: string;
  action: CleanupAction;
  detail?: string;
}

export interface RepoCleanupResult {
  repo_slug: string;
  repo_path: string;
  ok: boolean;
  worktrees: PerWorktreeResult[];
}

export interface CleanupRepo {
  repo_slug: string;
  repo_path: string;
}

/** Injected so tests do not need a GitHub remote. */
export type OpenPrProbe = (branch: string, cwd: string) => Promise<boolean>;

export const ghOpenPrProbe: OpenPrProbe = async (branch, cwd) => {
  const proc = Bun.spawn(
    ['gh', 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1'],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`gh pr list exited ${code}`);
  const parsed = JSON.parse(out.trim() || '[]') as unknown[];
  return Array.isArray(parsed) && parsed.length > 0;
};

export interface CleanupOptions {
  store: Store;
  repos: CleanupRepo[];
  ageDays: number;
  openPrProbe?: OpenPrProbe;
  /** Also delete the local branch when removing a worktree. */
  deleteBranch?: boolean;
}

export async function sweepStaleWorktrees(opts: CleanupOptions): Promise<RepoCleanupResult[]> {
  if (opts.ageDays <= 0) return [];
  const probe = opts.openPrProbe ?? ghOpenPrProbe;
  const results: RepoCleanupResult[] = [];

  for (const repo of opts.repos) {
    if (!existsSync(repo.repo_path)) {
      logger.debug('Skipping cleanup for a checkout that does not exist', {
        repo_slug: repo.repo_slug,
        repo_path: repo.repo_path,
      });
      continue;
    }

    let listing: WorktreeListing[];
    try {
      listing = await listWorktrees(opts.store, repo.repo_slug);
    } catch (err) {
      logger.warn('Worktree listing failed; skipping repo', {
        ...repo,
        error: (err as Error).message,
      });
      results.push({ ...repo, ok: false, worktrees: [] });
      continue;
    }

    const perTree: PerWorktreeResult[] = [];

    for (const wt of listing) {
      // The directory is gone but the row survived — drop the row so the
      // inventory stops lying, regardless of age.
      if (!wt.present) {
        await opts.store.deleteWorktree(repo.repo_slug, wt.branch);
        perTree.push({ branch: wt.branch, action: 'pruned_missing' });
        continue;
      }

      if (wt.age_days < opts.ageDays) {
        perTree.push({ branch: wt.branch, action: 'preserved_too_recent', detail: `age=${wt.age_days}d` });
        continue;
      }

      let prOpen: boolean;
      try {
        prOpen = await probe(wt.branch, repo.repo_path);
      } catch (err) {
        // Conservative: unable to tell means preserve. Deleting a worktree
        // behind an unreviewed PR is the one outcome worth being paranoid about.
        logger.warn('PR lookup failed; preserving worktree', {
          branch: wt.branch,
          error: (err as Error).message,
        });
        perTree.push({ branch: wt.branch, action: 'preserved_pr_open', detail: 'pr_lookup_failed' });
        continue;
      }

      if (prOpen) {
        perTree.push({ branch: wt.branch, action: 'preserved_pr_open' });
        continue;
      }

      try {
        await removeWorktree({
          repoPath: repo.repo_path,
          repoSlug: repo.repo_slug,
          branch: wt.branch,
          path: wt.path,
          force: true,
          deleteBranch: opts.deleteBranch ?? false,
          store: opts.store,
        });
        perTree.push({ branch: wt.branch, action: 'removed', detail: `age=${wt.age_days}d` });
      } catch (err) {
        perTree.push({ branch: wt.branch, action: 'failed', detail: (err as Error).message });
      }
    }

    const count = (a: CleanupAction) => perTree.filter((p) => p.action === a).length;
    logger.info('Worktree cleanup pass complete', {
      repo_slug: repo.repo_slug,
      age_days: opts.ageDays,
      total: listing.length,
      removed: count('removed'),
      preserved_pr_open: count('preserved_pr_open'),
      preserved_too_recent: count('preserved_too_recent'),
      pruned_missing: count('pruned_missing'),
      failed: count('failed'),
    });

    results.push({ ...repo, ok: count('failed') === 0, worktrees: perTree });
  }

  return results;
}
