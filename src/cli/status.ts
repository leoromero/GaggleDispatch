/**
 * `gaggle status` and `gaggle ps` (Section 21.9).
 */

import chalk from 'chalk';
import { loadConfig } from './common.ts';
import { loadSyncedRegistry } from '../registry/synced-registry.ts';
import { loadScaffoldJobs } from '../registry/scaffold-jobs.ts';
import { LinearClient } from '../tracker/linear.ts';

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
          : r.sync_status === 'missing_gaggle_md'
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

/** `gaggle ps` — query Linear gaggle labels to show live orchestrator state. */
/**
 * `gaggle ps` — what the control plane is doing.
 *
 * This used to fan out over `fetchIssuesByLabel` and reconstruct state from
 * whichever `gaggle:*` labels happened to be on each issue, which meant it
 * reported a projection and could disagree with reality. It now reads the same
 * board the dashboard does, so it needs no tracker credentials and works with
 * every gaggle process stopped.
 */
export async function runPs(opts: { cwd?: string; json?: boolean }): Promise<void> {
  const cfg = loadConfig({ cwd: opts.cwd });
  if (!cfg.database.url) {
    console.error(chalk.red('✗ No database configured. Set DATABASE_URL and run `gaggle doctor`.'));
    process.exit(1);
  }

  const { openControlReadPlane } = await import('../control/index.ts');
  const plane = await openControlReadPlane({ cfg });
  try {
    const rows = await plane.store.board({
      status: ['analysis_requested', 'analyzing', 'analyzed', 'analysis_failed', 'running'],
    });

    if (opts.json) {
      console.log(JSON.stringify({ tickets: rows }, null, 2));
      return;
    }

    console.log(chalk.bold('\nGaggleDispatch — control plane'));
    console.log('─'.repeat(76));

    if (rows.length === 0) {
      console.log(chalk.gray('  Nothing in flight.'));
      console.log(chalk.gray('  Import tickets, then press Analyze and Start in the dashboard.\n'));
      return;
    }

    for (const { ticket, targets } of rows) {
      console.log(
        `  ${chalk.bold(ticket.identifier.padEnd(10))} ${statusBadge(ticket.status)}  ${ticket.title}`,
      );
      if (ticket.external_terminal_at) {
        console.log(chalk.yellow('             ⚠ closed in the tracker while running'));
      }
      if (ticket.analysis_error) {
        console.log(chalk.red(`             ${ticket.analysis_error}`));
      }
      for (const t of targets) {
        const age = t.status_changed_at ? ` ${chalk.gray(ageFromIso(t.status_changed_at))}` : '';
        const extra = t.failure_reason ? chalk.red(`  ${t.failure_reason}`) : '';
        console.log(`             ${t.repo_alias.padEnd(18)} ${statusBadge(t.status)}${age}${extra}`);
      }
    }

    const counts = await plane.store.countTicketsByStatus();
    const gates = await plane.store.listPendingGates();
    console.log(chalk.bold('\n  Summary:'));
    console.log(`    ${chalk.green(String(counts.running ?? 0).padStart(3))} running`);
    console.log(`    ${chalk.cyan(String(counts.analyzed ?? 0).padStart(3))} analyzed, awaiting Start`);
    console.log(`    ${chalk.yellow(String(gates.length).padStart(3))} waiting for you at a gate`);
    console.log('');
  } finally {
    await plane.close();
  }
}

/** Colour a status without inventing new vocabulary for it. */
function statusBadge(status: string): string {
  const label = `[${status.replace(/_/g, ' ').toUpperCase()}]`;
  switch (status) {
    case 'running':
    case 'succeeded':
      return chalk.green(label);
    case 'gate_waiting':
    case 'blocked':
      return chalk.yellow(label);
    case 'failed':
    case 'analysis_failed':
      return chalk.red(label);
    case 'analyzed':
    case 'ready':
      return chalk.cyan(label);
    case 'excluded':
    case 'cancelled':
      return chalk.gray(label);
    default:
      return chalk.blue(label);
  }
}

function ageFromIso(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '?';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
