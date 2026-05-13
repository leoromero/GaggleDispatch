/**
 * `archon isolation cleanup <days>` invocation, run once at orchestrator
 * startup per registered repository. Removes worktrees that have been idle
 * longer than the configured threshold — catches the long tail of
 * abandoned, cancelled, and orphaned worktrees that the per-run
 * `--merged`-only hook leaves behind.
 *
 * Best-effort: a failing cleanup is logged but never blocks startup.
 */

import { existsSync } from 'node:fs';
import { logger } from '../util/logger.ts';

export interface RepoCleanupTarget {
  /** Display name for logs. */
  alias: string;
  /** Filesystem path to invoke `archon isolation cleanup` from. */
  cwd: string;
}

export interface StartupCleanupResult {
  alias: string;
  cwd: string;
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run `archon isolation cleanup <ageDays>` in each repo's checkout.
 * Skips repos whose `cwd` doesn't exist (not yet synced). Never throws —
 * returns a per-repo result list so the caller can log a summary.
 */
export async function runStartupArchonCleanup(args: {
  ageDays: number;
  repos: RepoCleanupTarget[];
  /** Override the executable / shell invocation. Default: 'archon'. */
  command?: string;
  /** Per-repo timeout in ms. Default: 30 000. */
  timeoutMs?: number;
}): Promise<StartupCleanupResult[]> {
  if (args.ageDays <= 0) return [];
  const cmd = args.command ?? 'archon';
  const timeoutMs = args.timeoutMs ?? 30_000;
  const out: StartupCleanupResult[] = [];

  for (const repo of args.repos) {
    if (!existsSync(repo.cwd)) {
      logger.debug('Skipping cleanup for unsynced repo', { alias: repo.alias, cwd: repo.cwd });
      continue;
    }

    try {
      const proc = Bun.spawn([cmd, 'isolation', 'cleanup', String(args.ageDays), '--cwd', repo.cwd], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Race the process against a timeout sentinel. On timeout, kill and
      // skip the stream reads — they'd block forever if the child never
      // closed its stdout/stderr handles.
      const TIMEOUT = Symbol('timeout');
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      });
      const finished = await Promise.race([proc.exited, timeoutPromise]);
      if (timer) clearTimeout(timer);

      if (finished === TIMEOUT) {
        try { proc.kill(); } catch { /* ignore */ }
        logger.warn('Archon worktree cleanup timed out', { alias: repo.alias, timeout_ms: timeoutMs });
        out.push({ alias: repo.alias, cwd: repo.cwd, ok: false, exit_code: null, stdout: '', stderr: '' });
        continue;
      }

      // Process exited — safe to drain streams now.
      const [stdoutTxt, stderrTxt] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ]);
      const exitCode = finished as number;
      const ok = exitCode === 0;
      out.push({
        alias: repo.alias,
        cwd: repo.cwd,
        ok,
        exit_code: exitCode,
        stdout: stdoutTxt.slice(0, 1000),
        stderr: stderrTxt.slice(0, 1000),
      });

      if (ok) {
        logger.info('Archon worktree cleanup ok', {
          alias: repo.alias,
          age_days: args.ageDays,
          summary: stdoutTxt.replace(/\[[0-9;]*m/g, '').trim().split('\n').slice(-1)[0]?.slice(0, 200),
        });
      } else {
        logger.warn('Archon worktree cleanup failed (non-zero exit; continuing)', {
          alias: repo.alias,
          exit_code: exitCode,
          stderr: stderrTxt.slice(0, 300),
        });
      }
    } catch (err) {
      logger.warn('Archon worktree cleanup spawn failed (continuing)', {
        alias: repo.alias,
        error: (err as Error).message,
      });
      out.push({
        alias: repo.alias, cwd: repo.cwd, ok: false, exit_code: null,
        stdout: '', stderr: '',
      });
    }
  }

  return out;
}
