/**
 * `gaggle doctor` — preflight the host before a run can fail halfway through.
 *
 * Every check here corresponds to something that, when missing, produces a
 * confusing failure deep inside a workflow: a `bash:` node that cannot spawn a
 * shell at node 12 of 18, or a run that cannot record its own state. Better to
 * say so up front.
 */

import chalk from 'chalk';
import { loadConfig, type GlobalOptions } from './common.ts';
import { PostgresStore } from '../executor/store/postgres.ts';
import { LATEST_VERSION } from '../executor/store/migrations.ts';
import { resolveBashPath } from '../executor/engine/shell.ts';
import { run } from '../util/subprocess.ts';

type Level = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  level: Level;
  detail: string;
  /** What the operator should do about it. */
  fix?: string;
}

async function which(cmd: string, args: string[] = ['--version']): Promise<string | null> {
  try {
    const res = await run([cmd, ...args], { timeoutMs: 10_000 });
    if (res.exitCode !== 0) return null;
    return (res.stdout || res.stderr).split(/\r?\n/)[0]?.trim() ?? '';
  } catch {
    return null;
  }
}

async function checkBash(): Promise<Check> {
  const resolved = resolveBashPath();
  if (!resolved) {
    return {
      name: 'bash',
      level: 'fail',
      detail: 'not found on PATH',
      fix:
        process.platform === 'win32'
          ? 'Install Git for Windows (which ships Git Bash) and ensure bash.exe is on PATH. ' +
            'Workflow `bash:` and `script:` nodes cannot run without it.'
          : 'Install bash. Workflow `bash:` and `script:` nodes cannot run without it.',
    };
  }
  const version = await which(resolved, ['--version']);
  return {
    name: 'bash',
    level: 'ok',
    detail: `${resolved}${version ? ` — ${version}` : ''}`,
  };
}

async function checkGit(): Promise<Check> {
  const v = await which('git');
  return v
    ? { name: 'git', level: 'ok', detail: v }
    : {
        name: 'git',
        level: 'fail',
        detail: 'not found on PATH',
        fix: 'Install git. Worktree isolation and repo syncing both require it.',
      };
}

async function checkGh(): Promise<Check> {
  const v = await which('gh');
  return v
    ? { name: 'gh', level: 'ok', detail: v }
    : {
        name: 'gh',
        level: 'warn',
        detail: 'not found on PATH',
        fix:
          'Install the GitHub CLI. Without it, worktree cleanup cannot tell whether a branch ' +
          'still backs an open PR, and conservatively preserves every worktree.',
      };
}

async function checkDatabase(databaseUrl: string): Promise<Check[]> {
  if (!databaseUrl) {
    return [
      {
        name: 'postgres',
        level: 'fail',
        detail: 'executor.database_url is empty',
        fix:
          'Set DATABASE_URL, or executor.database_url in WORKFLOW.md. ' +
          '`docker compose up -d` starts a local Postgres on port 55432.',
      },
    ];
  }

  let store: PostgresStore | null = null;
  try {
    store = new PostgresStore(databaseUrl, { maxConnections: 2 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = (store as any).sql;
    const rows = (await sql.unsafe('SELECT version() AS v')) as { v: string }[];
    const banner = rows[0]?.v?.split(',')[0] ?? 'connected';

    const applied = (await sql.unsafe(
      `SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations`,
    ).catch(() => [{ v: 0 }])) as { v: number }[];
    const at = Number(applied[0]?.v ?? 0);

    const checks: Check[] = [{ name: 'postgres', level: 'ok', detail: banner }];
    checks.push(
      at === LATEST_VERSION
        ? { name: 'schema', level: 'ok', detail: `at version ${at}` }
        : {
            name: 'schema',
            level: 'warn',
            detail: `at version ${at}, latest is ${LATEST_VERSION}`,
            fix: 'Run `gaggle db migrate` (or start the orchestrator — it migrates on boot).',
          },
    );
    return checks;
  } catch (err) {
    return [
      {
        name: 'postgres',
        level: 'fail',
        detail: (err as Error).message.split('\n')[0] ?? 'connection failed',
        fix: '`docker compose up -d` starts a local Postgres on port 55432.',
      },
    ];
  } finally {
    await store?.close().catch(() => {});
  }
}

const MARK: Record<Level, string> = {
  ok: chalk.green('✓'),
  warn: chalk.yellow('!'),
  fail: chalk.red('✗'),
};

export async function runDoctor(opts: GlobalOptions & { json?: boolean } = {}): Promise<void> {
  const cfg = loadConfig(opts);

  const checks: Check[] = [
    ...(await Promise.all([checkBash(), checkGit(), checkGh()])),
    ...(await checkDatabase(cfg.executor.database_url)),
  ];

  if (opts.json) {
    console.log(JSON.stringify({ checks }, null, 2));
  } else {
    console.log(chalk.bold('gaggle doctor\n'));
    for (const c of checks) {
      console.log(`  ${MARK[c.level]} ${c.name.padEnd(10)} ${c.detail}`);
      if (c.fix && c.level !== 'ok') console.log(chalk.gray(`      ${c.fix}`));
    }
    console.log();
  }

  // Warnings are survivable; a failed check means a workflow would break.
  if (checks.some((c) => c.level === 'fail')) process.exit(1);
}

/** `gaggle db migrate` — apply pending migrations and report the version. */
export async function runDbMigrate(opts: GlobalOptions = {}): Promise<void> {
  const cfg = loadConfig(opts);
  const store = new PostgresStore(cfg.executor.database_url, { maxConnections: 2 });
  try {
    await store.migrate();
    console.log(chalk.green(`✓ schema at version ${LATEST_VERSION}`));
  } finally {
    await store.close();
  }
}
