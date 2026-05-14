/**
 * `gaggle start` — orchestrator entry point.
 */

import chalk from 'chalk';
import { basename } from 'node:path';
import { commandExists } from '../util/subprocess.ts';
import { loadConfig, fatal } from './common.ts';
import { runSyncPass, startPeriodicSyncer } from '../registry/repo-syncer.ts';
import { startRegistryLoader } from '../registry/loader.ts';
import { LinearClient } from '../tracker/linear.ts';
import { ApiKeyAuth, OAuthAuth } from '../tracker/linear-auth.ts';
import { IssueAnalyzer } from '../analyzer/issue-analyzer.ts';
import type { ServiceConfig } from '../domain/types.ts';
import { WorkspaceManager } from '../workspace/workspace-manager.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { logger } from '../util/logger.ts';
import { watchFile } from '../config/watcher.ts';
import { startGaggleApi } from '../hub/gaggle-api.ts';
import { writeSidecar, removeSidecar } from '../hub/sidecar.ts';

/** Construct a LinearClient with the auth provider selected by the config. */
async function buildLinearClient(cfg: ServiceConfig): Promise<LinearClient> {
  if (cfg.tracker.auth.mode === 'oauth') {
    const auth = new OAuthAuth({
      client_id: cfg.tracker.auth.client_id,
      client_secret: cfg.tracker.auth.client_secret,
    });
    if (!auth.hasTokens()) {
      fatal('Linear OAuth tokens not found. Run `gaggle init` or `gaggle auth linear` to authorize.');
    }
    return new LinearClient(cfg, auth);
  }
  return new LinearClient(cfg, new ApiKeyAuth(cfg.tracker.api_key));
}

export async function runStart(opts: {
  cwd?: string;
  apiPort?: number;
  workspaceName?: string;
}): Promise<void> {
  const cfg = loadConfig({ cwd: opts.cwd });

  console.log(chalk.cyan('Preflight checks…'));
  if (!(await commandExists('gh'))) fatal(`'gh' CLI not found in PATH.`);
  if (!(await commandExists('git'))) fatal(`'git' not found in PATH.`);
  if (cfg.tracker.auth.mode === 'api_key') {
    if (!cfg.tracker.api_key) fatal(`tracker.api_key (LINEAR_API_KEY) is empty after $VAR resolution.`);
  } else {
    // OAuth: tokens come from auth.json. If they're missing, surface a clear
    // error pointing at the recovery command.
    const stored = (await import('../tracker/auth-store.ts')).loadStoredTokens();
    if (!stored) fatal(`Linear OAuth tokens not found. Run \`gaggle init\` or \`gaggle auth linear\` to authorize.`);
  }
  // Claude auth is handled by the subprocess env (CLAUDE_API_KEY / CLAUDE_CODE_OAUTH_TOKEN /
  // CLAUDE_USE_GLOBAL_AUTH). No preflight check needed here — auth failures surface at analysis time.

  // Startup warnings (Section 6.3)
  if (cfg.tracker.gate_waiting_state && cfg.tracker.active_states.includes(cfg.tracker.gate_waiting_state)) {
    logger.warn(
      `gate_waiting_state "${cfg.tracker.gate_waiting_state}" is also listed in active_states; gated issues will re-surface as dispatch candidates and rely solely on the gaggle:claimed label to avoid re-dispatch — configure a state outside active_states for a true parked lane.`,
    );
  }
  if (cfg.tracker.gate_resume_state && !cfg.tracker.active_states.includes(cfg.tracker.gate_resume_state)) {
    logger.warn(
      `gate_resume_state "${cfg.tracker.gate_resume_state}" is not listed in active_states; resumed issues will not be picked up by dispatch until they leave that state.`,
    );
  }

  if (cfg.registry.sync_on_startup) {
    console.log(chalk.cyan('Running initial sync pass...'));
    await runSyncPass(cfg, { quiet: false });
  }

  const registry = startRegistryLoader(cfg);
  const ctx = registry.getContext();
  if (ctx.repositories.length === 0) {
    fatal('Registry context has no repositories with sync_status=ok. Add a gaggle.md to at least one registered repo.');
  }

  // Sweep stale Archon worktrees (abandoned/cancelled/orphaned) before
  // polling kicks in. The per-run `after_run` hook handles merged branches
  // continuously; this catches the long tail. Configured via
  // archon.startup_cleanup_age_days (default 7; 0 to disable).
  if (cfg.archon.startup_cleanup_age_days > 0) {
    console.log(chalk.cyan(`Sweeping Archon worktrees idle > ${cfg.archon.startup_cleanup_age_days} days...`));
    const { runStartupArchonCleanup } = await import('../executor/archon-cleanup.ts');
    await runStartupArchonCleanup({
      ageDays: cfg.archon.startup_cleanup_age_days,
      repos: ctx.repositories.map((r) => ({ alias: r.name, cwd: r.local_path })),
    });
  }

  const tracker = await buildLinearClient(cfg);
  const analyzer = new IssueAnalyzer(cfg);
  const workspace = new WorkspaceManager(cfg);
  workspace.ensureAuxRoot();

  const syncer = startPeriodicSyncer(cfg);

  const orchestrator = new Orchestrator({ cfg, tracker, analyzer, workspace, registry, syncer });

  // Hot-reload WORKFLOW.md template body (full reload would be more invasive; we
  // surface a warning and recommend restart for full config changes).
  const wfWatch = watchFile(cfg.workflow_md_path, () => {
    logger.warn('WORKFLOW.md changed on disk. Restart `gaggle start` to apply config changes.');
    orchestrator.invalidateAnalysisCache();
  });

  // Optional local HTTP API server (used by the hub or when running standalone
  // and wanting the dashboard). Started when --api-port is passed (0 = auto).
  const wantApi = opts.apiPort !== undefined;
  const apiHandle = wantApi
    ? startGaggleApi({
        port: opts.apiPort ?? 0,
        workspaceName: opts.workspaceName ?? basename(cfg.project_dir),
        getState: () => orchestrator.getState(),
        onRedispatch: (issue_id, repo_alias) => orchestrator.redispatch(issue_id, repo_alias),
      })
    : null;

  if (apiHandle) {
    writeSidecar(cfg.project_dir, {
      pid: process.pid,
      api_port: apiHandle.port,
      api_url: apiHandle.url,
      workspace_name: opts.workspaceName ?? basename(cfg.project_dir),
      workflow_md_path: cfg.workflow_md_path,
      started_at: new Date().toISOString(),
    });
    console.log(chalk.cyan(`API server listening at ${apiHandle.url}`));
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.yellow(`\nReceived ${signal}, shutting down…`));
    if (apiHandle) {
      await apiHandle.stop();
      removeSidecar(cfg.project_dir);
    }
    syncer.stop();
    await wfWatch.close();
    await registry.close();
    await orchestrator.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await orchestrator.start();
  console.log(chalk.green(`✓ GaggleDispatch orchestrator running. Polling every ${cfg.polling.interval_ms}ms.`));
}
