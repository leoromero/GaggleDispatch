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
      console.log(`  ${j.slug}: ${j.last_status} (run-id ${j.run_id ?? '?'}, ${age} ago)`);
      if (j.pr_url) console.log(chalk.gray(`    PR: ${j.pr_url}`));
    }
  }
  console.log('');

  console.log(chalk.bold('Orchestrator:'));
  console.log(chalk.gray('  Service status: not running (use `gaggle start`)'));
}

/** `gaggle ps` — query Linear gaggle labels to show live orchestrator state. */
export async function runPs(opts: { cwd?: string }): Promise<void> {
  const cfg = loadConfig({ cwd: opts.cwd });

  let tracker: LinearClient;
  try {
    if (cfg.tracker.auth.mode === 'oauth') {
      const oauthMod = await import('../tracker/linear-auth.ts');
      const auth = new oauthMod.OAuthAuth({
        client_id: cfg.tracker.auth.client_id,
        client_secret: cfg.tracker.auth.client_secret,
      });
      if (!auth.hasTokens()) {
        console.error(chalk.red('✗ Linear OAuth tokens not found. Run `gaggle init` or `gaggle auth linear`.'));
        process.exit(1);
      }
      tracker = new LinearClient(cfg, auth);
    } else {
      const { ApiKeyAuth } = await import('../tracker/linear-auth.ts');
      tracker = new LinearClient(cfg, new ApiKeyAuth(cfg.tracker.api_key));
    }
  } catch (err) {
    console.error(chalk.red(`✗ Cannot connect to Linear: ${(err as Error).message}`));
    process.exit(1);
  }

  const labels = cfg.tracker.gaggle_labels;
  const labelDefs = [
    { key: 'claimed',       name: labels.claimed,       color: chalk.blue,   badge: 'CLAIMED'  },
    { key: 'running',       name: labels.running,       color: chalk.green,  badge: 'RUNNING'  },
    { key: 'queued',        name: labels.queued,        color: chalk.yellow, badge: 'QUEUED'   },
    { key: 'waiting_human', name: labels.waiting_human, color: chalk.red,    badge: 'WAITING'  },
  ] as const;

  const allIssues: Map<string, { issue: Awaited<ReturnType<typeof tracker.fetchIssuesByLabel>>[number]; badges: string[] }> = new Map();

  for (const def of labelDefs) {
    let issues: Awaited<ReturnType<typeof tracker.fetchIssuesByLabel>>;
    try {
      issues = await tracker.fetchIssuesByLabel(def.name);
    } catch (err) {
      console.error(chalk.red(`✗ Failed to fetch ${def.name}: ${(err as Error).message}`));
      continue;
    }
    for (const issue of issues) {
      const entry = allIssues.get(issue.id) ?? { issue, badges: [] };
      entry.badges.push(def.badge);
      allIssues.set(issue.id, entry);
    }
  }

  console.log(chalk.bold('\nGaggleDispatch — Live Orchestrator State'));
  console.log('─'.repeat(70));

  if (allIssues.size === 0) {
    console.log(chalk.gray('  No active gaggle issues found in Linear.'));
    console.log(chalk.gray('  (nothing is claimed, running, queued, or waiting for human input)\n'));
    return;
  }

  // Separate parents from sub-issues.
  const parents = [...allIssues.values()].filter((e) => !e.issue.parent_id);
  const children = [...allIssues.values()].filter((e) => !!e.issue.parent_id);

  if (parents.length > 0) {
    console.log(chalk.bold('\n  Parent issues:'));
    for (const { issue, badges } of parents) {
      const badgeStr = badges.map((b) => {
        if (b === 'RUNNING') return chalk.green(`[${b}]`);
        if (b === 'QUEUED')  return chalk.yellow(`[${b}]`);
        if (b === 'WAITING') return chalk.red(`[${b}]`);
        return chalk.blue(`[${b}]`);
      }).join(' ');
      console.log(`    ${chalk.bold(issue.identifier.padEnd(10))} ${badgeStr}  ${issue.title}`);
      if (issue.url) console.log(chalk.gray(`               ${issue.url}`));
    }
  }

  if (children.length > 0) {
    console.log(chalk.bold('\n  Sub-issues (active workers):'));
    for (const { issue, badges } of children) {
      const badgeStr = badges.map((b) => {
        if (b === 'RUNNING') return chalk.green(`[${b}]`);
        if (b === 'QUEUED')  return chalk.yellow(`[${b}]`);
        if (b === 'WAITING') return chalk.red(`[${b}]`);
        return chalk.blue(`[${b}]`);
      }).join(' ');
      console.log(`    ${chalk.bold(issue.identifier.padEnd(10))} ${badgeStr}  ${issue.title}`);
    }
  }

  const runningCount = [...allIssues.values()].filter((e) => e.badges.includes('RUNNING')).length;
  const queuedCount  = [...allIssues.values()].filter((e) => e.badges.includes('QUEUED')).length;
  const waitingCount = [...allIssues.values()].filter((e) => e.badges.includes('WAITING')).length;

  console.log(chalk.bold('\n  Summary:'));
  console.log(`    ${chalk.green(String(runningCount).padStart(3))} running`);
  console.log(`    ${chalk.yellow(String(queuedCount).padStart(3))} queued (blocked on dependency)`);
  console.log(`    ${chalk.red(String(waitingCount).padStart(3))} waiting for human input`);
  console.log('');
}

function ageFromIso(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '?';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
