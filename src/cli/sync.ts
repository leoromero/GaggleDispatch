/**
 * `gaggle sync` (Section 21.8).
 */

import chalk from 'chalk';
import { loadConfig } from './common.ts';
import { runSyncPass } from '../registry/repo-syncer.ts';
import { loadScaffoldJobs, removeJobBySlug, writeScaffoldJobs } from '../registry/scaffold-jobs.ts';

export async function runSync(opts: { cwd?: string; repo?: string; quiet?: boolean }): Promise<void> {
  const cfg = loadConfig({ cwd: opts.cwd });
  if (cfg.repositories.length === 0) {
    console.log(chalk.yellow('No repositories registered. Use `gaggle repo add <url>` to add some.'));
    return;
  }
  const result = await runSyncPass(cfg, { onlySlug: opts.repo, quiet: opts.quiet });

  // Auto-cleanup of scaffold jobs whose repo now has sync_status: ok (Section 21.7.1)
  const okSlugs = new Set(result.per_repo.filter((r) => r.sync_status === 'ok').map((r) => r.slug));
  let jobs = loadScaffoldJobs(cfg.registry.base_folder);
  let removed = 0;
  for (const job of [...jobs.jobs]) {
    if (okSlugs.has(job.slug) && (job.last_status === 'completed' || job.last_status === 'pending' || job.last_status === 'running')) {
      jobs = removeJobBySlug(jobs, job.slug);
      removed++;
    }
  }
  if (removed > 0) {
    writeScaffoldJobs(cfg.registry.base_folder, jobs);
    console.log(chalk.gray(`  Cleared ${removed} scaffold job(s) for repos that now have a valid symphony.md.`));
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
