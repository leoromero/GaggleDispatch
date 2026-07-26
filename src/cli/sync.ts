/**
 * `gaggle sync` (Section 21.8).
 */

import chalk from 'chalk';
import { loadConfig , withStore } from './common.ts';
import { runSyncPass } from '../registry/repo-syncer.ts';
import { loadScaffoldJobs, removeScaffoldJob } from '../registry/scaffold-jobs.ts';
import { runRepoScaffold } from './scaffold.ts';

const ACTIVE_SCAFFOLD_STATUSES = new Set(['pending', 'running', 'paused']);

export async function runSync(opts: { cwd?: string; repo?: string; quiet?: boolean }): Promise<void> {
  const cfg = loadConfig({ cwd: opts.cwd });
  if (cfg.repositories.length === 0) {
    console.log(chalk.yellow('No repositories registered. Use `gaggle repo add <url>` to add some.'));
    return;
  }
  const result = await withStore(cfg, (store) =>
    runSyncPass(cfg, { store, onlySlug: opts.repo, quiet: opts.quiet }),
  );

  // Auto-cleanup of scaffold jobs whose repo now has sync_status: ok (Section 21.7.1)
  const okSlugs = new Set(result.per_repo.filter((r) => r.sync_status === 'ok').map((r) => r.slug));
  let jobs = await withStore(cfg, (store) => loadScaffoldJobs(store));
  let removed = 0;
  await withStore(cfg, async (store) => {
    for (const job of jobs.jobs) {
      if (
        okSlugs.has(job.slug) &&
        (job.last_status === 'completed' || job.last_status === 'pending' || job.last_status === 'running')
      ) {
        await removeScaffoldJob(store, job.slug);
        removed++;
      }
    }
  });
  if (removed > 0) {
    console.log(chalk.gray(`  Cleared ${removed} scaffold job(s) for repos that now have a valid gaggle.md.`));
  }

  // Auto-scaffold: for every repo missing a gaggle.md, launch an async scaffold
  // job unless one is already in flight. Controlled by registry.auto_scaffold (default: true).
  if (cfg.registry.auto_scaffold) {
    const missingRepos = result.per_repo.filter((r) => r.sync_status === 'missing_gaggle_md');
    if (missingRepos.length > 0) {
      // Reload jobs list (may have been mutated above).
      jobs = await withStore(cfg, (store) => loadScaffoldJobs(store));
      const activeBySlug = new Map(jobs.jobs.filter((j) => ACTIVE_SCAFFOLD_STATUSES.has(j.last_status)).map((j) => [j.slug, j]));

      for (const repo of missingRepos) {
        if (activeBySlug.has(repo.slug)) {
          console.log(chalk.gray(`  scaffold already in flight for ${repo.slug} — skipping`));
          continue;
        }
        const src = cfg.repositories.find((r) => r.url === repo.url);
        if (!src) continue;
        try {
          await runRepoScaffold({ url: src.url, cwd: opts.cwd, async: true });
        } catch (err) {
          console.log(chalk.yellow(`  ✗ scaffold launch failed for ${repo.slug}: ${(err as Error).message}`));
        }
      }
    }
  }

  console.log(
    `${chalk.green(`✓ ${result.ok} ok`)} · ` +
      `${chalk.yellow(`${result.missing} missing`)} · ` +
      `${chalk.red(`${result.errors} errors`)} · ${result.per_repo.length} total`,
  );

  for (const r of result.per_repo) {
    if (r.sync_status === 'ok') continue;
    const colorize = r.sync_status === 'error' ? chalk.red : chalk.yellow;
    console.log(colorize(`  ${r.slug}: ${r.sync_status}`));
    if (r.sync_error) console.log(chalk.gray(`    ${r.sync_error}`));
  }

  if (result.errors > 0) {
    process.exit(1);
  }
}
