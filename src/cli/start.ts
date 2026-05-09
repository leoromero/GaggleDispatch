/**
 * `gaggle start` — orchestrator entry point.
 */

import chalk from 'chalk';
import { commandExists } from '../util/subprocess.ts';
import { loadConfig, fatal } from './common.ts';
import { runSyncPass, startPeriodicSyncer } from '../registry/repo-syncer.ts';
import { startRegistryLoader } from '../registry/loader.ts';
import { LinearClient } from '../tracker/linear.ts';
import { IssueAnalyzer } from '../analyzer/issue-analyzer.ts';
import { WorkspaceManager } from '../workspace/workspace-manager.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { logger } from '../util/logger.ts';
import { watchFile } from '../config/watcher.ts';

export async function runStart(opts: { cwd?: string }): Promise<void> {
  const cfg = loadConfig({ cwd: opts.cwd });

  console.log(chalk.cyan('Preflight checks…'));
  if (!(await commandExists('gh'))) fatal(`'gh' CLI not found in PATH.`);
  if (!(await commandExists('git'))) fatal(`'git' not found in PATH.`);
  if (!cfg.tracker.api_key) fatal(`tracker.api_key (LINEAR_API_KEY) is empty after $VAR resolution.`);
  if (!cfg.claude.api_key) fatal(`claude.api_key (ANTHROPIC_API_KEY) is empty after $VAR resolution.`);

  // Startup warnings (Section 6.3)
  if (cfg.tracker.gate_waiting_state && cfg.tracker.active_states.includes(cfg.tracker.gate_waiting_state)) {
    logger.warn(
      `gate_waiting_state "${cfg.tracker.gate_waiting_state}" is also listed in active_states; gated issues will re-surface as dispatch candidates and rely solely on the symphony:claimed label to avoid re-dispatch — configure a state outside active_states for a true parked lane.`,
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
    fatal('Registry context has no repositories with sync_status=ok. Add a symphony.md to at least one registered repo.');
  }

  const tracker = new LinearClient(cfg);
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

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.yellow(`\nReceived ${signal}, shutting down…`));
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
