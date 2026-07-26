/**
 * `gaggle doctor` — preflight the things that fail confusingly at run time.
 *
 * Scoped deliberately: each check answers a question an operator would otherwise
 * have to answer by reading a stack trace. Postgres is now a hard prerequisite,
 * so "is the database reachable and migrated" is the headline, and a
 * non-loopback dashboard host is called out because the board became a surface
 * that can start agents.
 */

import chalk from 'chalk';
import { loadHubConfig } from '../hub/config.ts';
import { openSql } from '../store/sql.ts';
import { currentVersion, pendingVersions } from '../store/migrate.ts';
import { CONTROL_MIGRATIONS } from '../control/store/migrations.ts';
import { loadConfig, type GlobalOptions } from './common.ts';
import { commandExists } from '../util/subprocess.ts';

type Level = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  level: Level;
  detail: string;
  /** What to do about it. Omitted when there is nothing to do. */
  fix?: string;
}

export async function runDoctor(opts: GlobalOptions & { json?: boolean } = {}): Promise<void> {
  const checks: Check[] = [];

  // ── config ──────────────────────────────────────────────────────────────
  let cfg;
  try {
    cfg = loadConfig(opts);
    checks.push({ name: 'config', level: 'ok', detail: 'WORKFLOW.md parsed' });
  } catch (err) {
    // loadConfig exits on a missing file, so reaching here means invalid content.
    checks.push({
      name: 'config',
      level: 'fail',
      detail: (err as Error).message,
      fix: 'Fix the front matter in WORKFLOW.md',
    });
    report(checks, opts.json);
    return;
  }

  // ── external tools ──────────────────────────────────────────────────────
  for (const [tool, why] of [
    ['git', 'worktrees and branch operations'],
    ['gh', 'PR creation and merge detection'],
  ] as const) {
    checks.push(
      (await commandExists(tool))
        ? { name: tool, level: 'ok', detail: `on PATH (${why})` }
        : { name: tool, level: 'fail', detail: `not on PATH — needed for ${why}`, fix: `Install ${tool}` },
    );
  }

  // ── database ────────────────────────────────────────────────────────────
  if (!cfg.database.url) {
    checks.push({
      name: 'database',
      level: 'fail',
      detail: 'no connection string configured',
      fix: 'Set DATABASE_URL, or database.url in WORKFLOW.md, then run `docker compose up -d`',
    });
  } else {
    const sql = openSql(cfg.database.url);
    try {
      const rows = (await sql`SELECT current_database() AS db, version() AS v`) as Array<{
        db: string;
        v: string;
      }>;
      const server = String(rows[0]?.v ?? '').split(' ').slice(0, 2).join(' ');
      checks.push({
        name: 'database',
        level: 'ok',
        detail: `connected to ${rows[0]?.db} (${server})`,
      });

      const pending = await pendingVersions(sql, CONTROL_MIGRATIONS);
      const applied = await currentVersion(sql);
      checks.push(
        pending.length === 0
          ? { name: 'migrations', level: 'ok', detail: `control-plane schema current (at ${applied})` }
          : {
              name: 'migrations',
              level: 'warn',
              detail: `${pending.length} control-plane migration(s) pending: ${pending.join(', ')}`,
              fix: 'They apply automatically on `gaggle start`',
            },
      );
    } catch (err) {
      checks.push({
        name: 'database',
        level: 'fail',
        detail: (err as Error).message,
        fix: 'Start Postgres with `docker compose up -d`, then check database.url',
      });
    } finally {
      await sql.close().catch(() => {});
    }
  }

  // ── dashboard exposure ──────────────────────────────────────────────────
  // The board can start agents that write code and open PRs, and there is no
  // authentication in front of it. Loopback is the only thing protecting it.
  try {
    const hub = loadHubConfig();
    const host = hub.ui.host ?? '127.0.0.1';
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    checks.push(
      loopback
        ? { name: 'dashboard', level: 'ok', detail: `bound to ${host} (loopback)` }
        : {
            name: 'dashboard',
            level: 'warn',
            detail: `bound to ${host} — the board can dispatch work and has no authentication`,
            fix: 'Set ui.host to 127.0.0.1, or put an authenticating proxy in front of it',
          },
    );
  } catch {
    checks.push({ name: 'dashboard', level: 'ok', detail: 'no nest config yet' });
  }

  // ── tracker credentials ─────────────────────────────────────────────────
  const hasKey = cfg.tracker.auth.mode === 'oauth' || Boolean(cfg.tracker.api_key);
  checks.push(
    hasKey
      ? { name: 'tracker', level: 'ok', detail: `${cfg.tracker.kind} auth via ${cfg.tracker.auth.mode}` }
      : {
          name: 'tracker',
          level: 'fail',
          detail: 'no tracker credentials — tickets cannot be imported',
          fix: 'Set LINEAR_API_KEY, or run `gaggle auth linear`',
        },
  );

  report(checks, opts.json);
}

function report(checks: Check[], json?: boolean): void {
  if (json) {
    console.log(JSON.stringify({ checks }, null, 2));
  } else {
    for (const c of checks) {
      const mark = c.level === 'ok' ? chalk.green('✓') : c.level === 'warn' ? chalk.yellow('⚠') : chalk.red('✗');
      console.log(`  ${mark} ${chalk.bold(c.name.padEnd(11))} ${c.detail}`);
      if (c.fix && c.level !== 'ok') console.log(`    ${chalk.dim('→ ' + c.fix)}`);
    }
    const failed = checks.filter((c) => c.level === 'fail').length;
    const warned = checks.filter((c) => c.level === 'warn').length;
    console.log();
    console.log(
      failed > 0
        ? chalk.red(`${failed} check(s) failed`)
        : warned > 0
          ? chalk.yellow(`All required checks passed, ${warned} warning(s)`)
          : chalk.green('All checks passed'),
    );
  }
  if (checks.some((c) => c.level === 'fail')) process.exitCode = 1;
}
