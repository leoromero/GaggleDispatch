/**
 * `gaggle status` (Section 21.9).
 */

import chalk from 'chalk';
import { loadConfig } from './common.ts';
import { loadSyncedRegistry } from '../registry/synced-registry.ts';
import { loadScaffoldJobs } from '../registry/scaffold-jobs.ts';

export async function runStatus(opts: { cwd?: string; json?: boolean }): Promise<void> {
  const cfg = loadConfig({ cwd: opts.cwd });
  const synced = loadSyncedRegistry(cfg.registry.base_folder);
  const jobs = loadScaffoldJobs(cfg.registry.base_folder);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          source_registry: { count: cfg.repositories.length, repositories: cfg.repositories },
          synced_registry: synced,
          scaffold_jobs: jobs,
          orchestrator: { running: false },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(chalk.bold('GaggleDispatch Runtime Snapshot'));
  console.log('================================\n');

  console.log(chalk.bold('Source Registry (WORKFLOW.md):'));
  console.log(`  ${cfg.repositories.length} repositories registered.\n`);

  console.log(chalk.bold('Synced Registry (registry.synced.yaml):'));
  if (!synced) {
    console.log(chalk.gray('  (not synced — run `gaggle sync`)'));
  } else {
    console.log(`  Last synced: ${synced.synced_at}`);
    for (const r of synced.repositories) {
      const mark =
        r.sync_status === 'ok'
          ? chalk.green('✓')
          : r.sync_status === 'missing_symphony_md'
          ? chalk.yellow('⚠')
          : chalk.red('✗');
      const sha = r.last_commit_sha ? r.last_commit_sha.slice(0, 8) : '?';
      console.log(`  ${mark} ${r.slug.padEnd(36)} (${r.sync_status}, commit ${sha})`);
      if (r.sync_error) console.log(chalk.gray(`      ${r.sync_error}`));
    }
  }
  console.log('');

  console.log(chalk.bold('Scaffold Jobs (scaffold_jobs.yaml):'));
  if (jobs.jobs.length === 0) {
    console.log(chalk.gray('  (none)'));
  } else {
    for (const j of jobs.jobs) {
      const age = j.started_at ? ageFromIso(j.started_at) : '?';
      console.log(`  ${j.slug}: ${j.last_status} (run-id ${j.archon_run_id ?? '?'}, ${age} ago)`);
      if (j.pr_url) console.log(chalk.gray(`    PR: ${j.pr_url}`));
    }
  }
  console.log('');

  console.log(chalk.bold('Orchestrator:'));
  console.log(chalk.gray('  Service status: not running (use `gaggle start`)'));
}

function ageFromIso(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '?';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
