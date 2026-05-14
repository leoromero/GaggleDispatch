/**
 * `gaggle nest` — multi-gaggle nest commands.
 */

import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  addWorkspace,
  defaultHubConfigPath,
  ensureHubConfig,
  loadHubConfig,
  removeWorkspace,
  saveHubConfig,
} from '../hub/config.ts';
import { HubProcessManager, resolveCliEntry } from '../hub/process-manager.ts';
import { startHubServer } from '../hub/server.ts';
import { ArchonSupervisor } from '../hub/archon-supervisor.ts';
import { logger } from '../util/logger.ts';
import { readSidecar, isPidAlive } from '../hub/sidecar.ts';

export async function runNestInit(): Promise<void> {
  const path = defaultHubConfigPath();
  if (existsSync(path)) {
    console.log(chalk.cyan(`Nest config already exists at ${path}`));
    return;
  }
  ensureHubConfig(path);
  console.log(chalk.green(`✓ Created ${path}`));
  console.log(chalk.dim(`  Add workspaces with: gaggle nest add <path>`));
}

export async function runNestAdd(opts: { path: string; name?: string; color?: string }): Promise<void> {
  const absPath = isAbsolute(opts.path) ? opts.path : resolve(process.cwd(), opts.path);
  if (!existsSync(absPath)) {
    console.error(chalk.red(`✗ Path does not exist: ${absPath}`));
    process.exit(1);
  }
  const workflowMd = join(absPath, 'WORKFLOW.md');
  if (!existsSync(workflowMd)) {
    console.error(chalk.red(`✗ No WORKFLOW.md at ${workflowMd}. Run 'gaggle init' there first.`));
    process.exit(1);
  }
  const name = opts.name ?? basename(absPath);
  const cfg = ensureHubConfig();
  const { cfg: next, added } = addWorkspace(cfg, { name, path: absPath, color: opts.color });
  if (!added) {
    console.error(chalk.red(`✗ A workspace named '${name}' is already registered.`));
    process.exit(1);
  }
  saveHubConfig(next);
  console.log(chalk.green(`✓ Added workspace '${name}' → ${absPath}`));
}

export async function runNestRemove(opts: { name: string }): Promise<void> {
  const cfg = loadHubConfig();
  const { cfg: next, removed } = removeWorkspace(cfg, opts.name);
  if (!removed) {
    console.error(chalk.red(`✗ No workspace named '${opts.name}'`));
    process.exit(1);
  }
  saveHubConfig(next);
  console.log(chalk.green(`✓ Removed workspace '${opts.name}'`));
}

export async function runNestList(opts: { json?: boolean }): Promise<void> {
  const cfg = loadHubConfig();
  if (opts.json) {
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }
  if (cfg.workspaces.length === 0) {
    console.log(chalk.dim('No workspaces registered. Use: gaggle nest add <path>'));
    return;
  }
  console.log(chalk.bold('Registered workspaces:'));
  for (const w of cfg.workspaces) {
    const sc = readSidecar(w.path);
    const alive = sc && isPidAlive(sc.pid);
    const status = alive ? chalk.green('● running') : chalk.gray('○ stopped');
    const meta = alive && sc ? chalk.dim(`  ${sc.api_url}  pid=${sc.pid}`) : '';
    const dot = w.color ? chalk.hex(w.color)('●') : '●';
    console.log(`  ${dot} ${chalk.bold(w.name)}  ${status}  ${chalk.dim(w.path)}${meta}`);
  }
  console.log();
  console.log(chalk.dim(`UI: http://${cfg.ui.host ?? '127.0.0.1'}:${cfg.ui.port}`));
}

export async function runNestStatus(opts: { json?: boolean }): Promise<void> {
  // Lightweight status — uses sidecars only, no need for hub to be running.
  const cfg = loadHubConfig();
  const entries = cfg.workspaces.map((w) => {
    const sc = readSidecar(w.path);
    const alive = sc ? isPidAlive(sc.pid) : false;
    return {
      name: w.name,
      path: w.path,
      color: w.color,
      running: alive,
      api_url: alive ? sc?.api_url ?? null : null,
      pid: alive ? sc?.pid ?? null : null,
      started_at: alive ? sc?.started_at ?? null : null,
    };
  });
  if (opts.json) {
    console.log(JSON.stringify({ workspaces: entries, ui: cfg.ui }, null, 2));
    return;
  }
  for (const e of entries) {
    const badge = e.running ? chalk.green('● running') : chalk.gray('○ stopped');
    console.log(`  ${chalk.bold(e.name)}  ${badge}  ${chalk.dim(e.path)}`);
  }
}

export async function runNestStart(opts: { only?: string[] }): Promise<void> {
  const cfg = loadHubConfig();
  if (cfg.workspaces.length === 0) {
    console.error(chalk.red(`✗ No workspaces registered. Run: gaggle nest add <path>`));
    process.exit(1);
  }
  const targets = opts.only?.length
    ? cfg.workspaces.filter((w) => opts.only!.includes(w.name))
    : cfg.workspaces;

  if (targets.length === 0) {
    console.error(chalk.red(`✗ None of the requested workspaces match the registered list.`));
    process.exit(1);
  }

  const manager = new HubProcessManager({ cliEntry: resolveCliEntry() });

  console.log(chalk.cyan(`Starting nest with ${targets.length} workspace(s)…`));
  for (const w of targets) {
    await manager.startWorkspace(w);
  }

  // Archon supervisor: detect / adopt / spawn as configured.
  const archon = new ArchonSupervisor(cfg.archon);
  await archon.start();
  const archonState = archon.getState();
  if (archonState.status === 'running') {
    console.log(
      chalk.green(
        `✓ Archon UI at ${archonState.ui_url}${archonState.spawned_by_hub ? ' (spawned)' : ' (adopted)'}`,
      ),
    );
  } else if (archonState.status === 'disabled') {
    console.log(chalk.dim(`Archon autostart disabled; deep-links will be inactive`));
  } else {
    console.log(chalk.yellow(`Archon unreachable at ${archonState.ui_url}; continuing`));
  }

  // Start hub server.
  const dashboardDir = resolveDashboardDir();
  const hub = startHubServer({ cfg, manager, archon, dashboardDir });
  console.log(chalk.green(`✓ Nest dashboard at ${hub.url}`));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.yellow(`\nReceived ${signal}, shutting down nest…`));
    try {
      await hub.stop();
    } catch (e) {
      logger.warn('Hub stop error', { error: (e as Error).message });
    }
    try {
      await archon.stop();
    } catch (e) {
      logger.warn('Archon supervisor stop error', { error: (e as Error).message });
    }
    try {
      await manager.stopAll();
    } catch (e) {
      logger.warn('Manager stop error', { error: (e as Error).message });
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function resolveDashboardDir(): string {
  // Resolve relative to this source file (src/cli/) → ../../dashboard
  const here = new URL('.', import.meta.url).pathname;
  // On Windows, pathname starts with '/C:/...' — strip the leading slash.
  const cleaned = process.platform === 'win32' && /^\/[a-zA-Z]:/.test(here)
    ? here.slice(1)
    : here;
  return resolve(cleaned, '..', '..', 'dashboard');
}
