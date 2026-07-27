/**
 * Common helpers for CLI commands: load workflow + build service config.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadWorkflowDefinition, resolveWorkflowPath } from '../config/loader.ts';
import { buildServiceConfig } from '../config/service-config.ts';
import { GaggleError } from '../domain/errors.ts';
import type { ServiceConfig } from '../domain/types.ts';
import { PostgresStore } from '../executor/store/postgres.ts';
import { GaggleExecutor } from '../executor/engine/index.ts';
import { join } from 'node:path';

export interface GlobalOptions {
  cwd?: string;
}

export function loadConfig(opts: GlobalOptions = {}): ServiceConfig {
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
  const path = resolveWorkflowPath({ cwd });
  if (!existsSync(path)) {
    fatal(
      `WORKFLOW.md not found at ${path}.\n  Run 'gaggle init' to create one, or use --cwd <dir> to point at an existing project.`,
    );
  }
  const def = loadWorkflowDefinition({ cwd });
  return buildServiceConfig(def);
}

export function fatal(message: string, err?: unknown): never {
  console.error(chalk.red(`✗ ${message}`));
  if (err instanceof GaggleError) {
    console.error(chalk.gray(`  [${err.code}] ${err.message}`));
  } else if (err instanceof Error) {
    console.error(chalk.gray(`  ${err.message}`));
  }
  process.exit(1);
}

export function success(message: string): void {
  console.log(chalk.green(`✓ ${message}`));
}

export function info(message: string): void {
  console.log(chalk.cyan(`• ${message}`));
}

/**
 * Open a store for a one-shot CLI command.
 *
 * Small pool and an explicit close: these are short-lived processes, and a
 * lingering connection keeps the process alive after the command has printed
 * its output.
 */
export async function withStore<T>(
  cfg: ServiceConfig,
  fn: (store: PostgresStore) => Promise<T>,
): Promise<T> {
  const store = new PostgresStore(cfg.database.url, { maxConnections: 3 });
  try {
    await store.migrate();
    return await fn(store);
  } finally {
    await store.close();
  }
}

/**
 * Build the engine the way every command should.
 *
 * Factored out because `gaggle repo scaffold` built one inline with no
 * `config`, so it silently ignored every `executor.*` timing an operator had
 * set — a scaffold run used the built-in defaults for node idle, bash timeout,
 * run duration and the lease pair while `gaggle start` used the configured
 * ones.
 */
export function buildExecutor(cfg: ServiceConfig, store: PostgresStore): GaggleExecutor {
  return new GaggleExecutor({
    store,
    artifactsRoot: join(cfg.registry.base_folder, 'artifacts'),
    config: {
      nodeIdleTimeoutMs: cfg.executor.node_idle_timeout_ms,
      bashTimeoutMs: cfg.executor.bash_timeout_ms,
      maxRunDurationMs: cfg.executor.max_run_duration_ms,
      leaseHeartbeatMs: cfg.executor.lease_heartbeat_ms,
      leaseTtlMs: cfg.executor.lease_ttl_ms,
      maxTurns: cfg.agent.max_turns,
    },
  });
}
