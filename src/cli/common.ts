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
  const store = new PostgresStore(cfg.executor.database_url, { maxConnections: 3 });
  try {
    await store.migrate();
    return await fn(store);
  } finally {
    await store.close();
  }
}
