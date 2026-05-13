#!/usr/bin/env bun
/**
 * GaggleDispatch CLI entry point.
 * Symphony spec, Section 21.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { runSetup } from './setup.ts';
import { runInit } from './init.ts';
import { runRepoAdd } from './repo-add.ts';
import { runRepoRemove } from './repo-remove.ts';
import { runRepoList } from './repo-list.ts';
import { runRepoScaffold, runScaffoldStatus, runScaffoldCancel } from './scaffold.ts';
import { runSync } from './sync.ts';
import { runStatus, runPs } from './status.ts';
import { runStart } from './start.ts';
import { runTemplatesUpdate } from './templates-update.ts';
import {
  runHubAdd,
  runHubInit,
  runHubList,
  runHubRemove,
  runHubStart,
  runHubStatus,
} from './hub.ts';
import { GaggleError } from '../domain/errors.ts';

const program = new Command();
program
  .name('gaggle')
  .description('GaggleDispatch — federated multi-repo AI coding orchestrator')
  .version('0.1.0')
  .option('--cwd <path>', 'working directory containing WORKFLOW.md');

// ── setup ───────────────────────────────────────────────────────────────────
program
  .command('setup')
  .description('Interactive API key wizard')
  .option('--reset', 'overwrite existing keys')
  .action(async (opts: { reset?: boolean }) => {
    await runSetup({ reset: opts.reset });
  });

// ── init ────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Bootstrap a new GaggleDispatch deployment (creates WORKFLOW.md)')
  .action(async () => {
    await runInit({ cwd: program.opts().cwd });
  });

// ── repo subcommands ────────────────────────────────────────────────────────
const repo = program.command('repo').description('Manage the Source Registry');

repo
  .command('add <url>')
  .description('Register a repository in the Source Registry')
  .option('--default-branch <name>', 'override automatic detection')
  .option('--no-probe', 'skip the gh repo view probe')
  .action(async (url: string, opts: { defaultBranch?: string; probe?: boolean }) => {
    await runRepoAdd({
      url,
      defaultBranch: opts.defaultBranch,
      noProbe: opts.probe === false,
      cwd: program.opts().cwd,
    });
  });

repo
  .command('remove <urlOrSlug>')
  .description('Deregister a repository (preserves local checkout)')
  .action(async (target: string) => {
    await runRepoRemove({ target, cwd: program.opts().cwd });
  });

repo
  .command('list')
  .description('List registered repositories with sync status')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    await runRepoList({ cwd: program.opts().cwd, json: opts.json });
  });

repo
  .command('scaffold <url>')
  .description('Generate a draft gaggle.md PR via Archon (blocking; --async to detach)')
  .option('--async', 'detach and return immediately')
  .option('--branch <name>', 'override the working branch')
  .option('--message <text>', 'override the user message passed to Archon')
  .option('--from-branch <name>', 'pass through to Archon as --from')
  .action(async (
    url: string,
    opts: { async?: boolean; branch?: string; message?: string; fromBranch?: string },
  ) => {
    await runRepoScaffold({
      url,
      cwd: program.opts().cwd,
      async: opts.async,
      branch: opts.branch,
      message: opts.message,
      fromBranch: opts.fromBranch,
    });
  });

// ── scaffold subcommands ────────────────────────────────────────────────────
const scaffold = program.command('scaffold').description('Manage scaffold jobs');
scaffold
  .command('status')
  .description('Refresh and list in-flight scaffold jobs')
  .option('--json', 'machine-readable output')
  .option('--refresh-pr', 'force re-resolve every job\'s PR URL')
  .action(async (opts: { json?: boolean; refreshPr?: boolean }) => {
    await runScaffoldStatus({ cwd: program.opts().cwd, json: opts.json, refreshPr: opts.refreshPr });
  });
scaffold
  .command('cancel <slug>')
  .description('Abandon a scaffold job and remove it from scaffold_jobs.yaml')
  .action(async (slug: string) => {
    await runScaffoldCancel({ slug, cwd: program.opts().cwd });
  });

// ── sync ────────────────────────────────────────────────────────────────────
program
  .command('sync')
  .description('Run a single Repo Syncer pass on demand')
  .option('--repo <slug>', 'sync only one repository')
  .option('--quiet', 'suppress per-repo progress lines')
  .action(async (opts: { repo?: string; quiet?: boolean }) => {
    await runSync({ cwd: program.opts().cwd, repo: opts.repo, quiet: opts.quiet });
  });

// ── status ──────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Print runtime snapshot (registry + scaffold jobs)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    await runStatus({ cwd: program.opts().cwd, json: opts.json });
  });

// ── ps ──────────────────────────────────────────────────────────────────────
program
  .command('ps')
  .description('Show live orchestrator state by querying Linear gaggle labels')
  .action(async () => {
    await runPs({ cwd: program.opts().cwd });
  });

// ── templates ───────────────────────────────────────────────────────────────
const templates = program.command('templates').description('Manage workflow templates');

templates
  .command('update')
  .description('Overwrite workflow templates with the bundled defaults')
  .option('--dry-run', 'show what would change without writing anything')
  .action(async (opts: { dryRun?: boolean }) => {
    await runTemplatesUpdate({ cwd: program.opts().cwd, dry: opts.dryRun });
  });

// ── start ───────────────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start the orchestrator service')
  .option('--api-port <port>', 'expose the local HTTP API on this port (0 = auto)')
  .option('--workspace-name <name>', 'workspace name reported via the API (defaults to project dir name)')
  .action(async (opts: { apiPort?: string; workspaceName?: string }) => {
    const apiPort = opts.apiPort !== undefined ? Number(opts.apiPort) : undefined;
    if (apiPort !== undefined && !Number.isFinite(apiPort)) {
      console.error(chalk.red(`✗ --api-port must be a number`));
      process.exit(1);
    }
    await runStart({ cwd: program.opts().cwd, apiPort, workspaceName: opts.workspaceName });
  });

// ── hub ─────────────────────────────────────────────────────────────────────
const hub = program.command('hub').description('Manage multiple gaggles and the dashboard UI');

hub
  .command('init')
  .description('Create the hub config file at ~/.config/gaggle/hub.yaml')
  .action(async () => {
    await runHubInit();
  });

hub
  .command('add <path>')
  .description('Register a gaggle workspace (a directory containing WORKFLOW.md)')
  .option('--name <name>', 'override the workspace name (defaults to directory name)')
  .option('--color <hex>', 'override the assigned color (e.g. #4f9cf9)')
  .action(async (path: string, opts: { name?: string; color?: string }) => {
    await runHubAdd({ path, name: opts.name, color: opts.color });
  });

hub
  .command('remove <name>')
  .description('Unregister a gaggle workspace')
  .action(async (name: string) => {
    await runHubRemove({ name });
  });

hub
  .command('list')
  .description('List registered workspaces and their live status')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    await runHubList({ json: opts.json });
  });

hub
  .command('status')
  .description('Show status of each workspace (via sidecar files; hub need not be running)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    await runHubStatus({ json: opts.json });
  });

hub
  .command('start')
  .description('Start every registered workspace + the dashboard UI')
  .option('--only <names...>', 'only start the named workspaces')
  .action(async (opts: { only?: string[] }) => {
    await runHubStart({ only: opts.only });
  });

// ── auth ────────────────────────────────────────────────────────────────────
const auth = program.command('auth').description('Authorize gaggle with external services');

auth
  .command('linear')
  .description('Run the Linear OAuth authorization flow and store tokens')
  .action(async () => {
    const { runAuthLinear } = await import('./auth.ts');
    await runAuthLinear({ cwd: program.opts().cwd });
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof GaggleError) {
    console.error(chalk.red(`✗ [${err.code}] ${err.message}`));
  } else {
    console.error(chalk.red(`✗ ${(err as Error).message ?? err}`));
  }
  process.exit(1);
});
