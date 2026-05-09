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
import { runStatus } from './status.ts';
import { runStart } from './start.ts';
import { GaggleError } from '../domain/errors.ts';

const program = new Command();
program
  .name('gaggle')
  .alias('symphony')
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
  .description('Generate a draft symphony.md PR via Archon (blocking; --async to detach)')
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

// ── start ───────────────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start the orchestrator service')
  .action(async () => {
    await runStart({ cwd: program.opts().cwd });
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof GaggleError) {
    console.error(chalk.red(`✗ [${err.code}] ${err.message}`));
  } else {
    console.error(chalk.red(`✗ ${(err as Error).message ?? err}`));
  }
  process.exit(1);
});
