/**
 * Workspace Manager (Section 10).
 *
 * In the federated registry model, the per-repo "base checkout" is owned by
 * the Repo Syncer at `<base_folder>/repos/<slug>/`. The Workspace Manager
 * validates the path, runs hooks, and (optionally) syncs workflow templates.
 *
 * The legacy `workspace.root` is preserved for auxiliary scratch (Section 10.4).
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidWorkspaceCwd, RepoCloneError } from '../domain/errors.ts';
import type { Issue, RepoTarget, ServiceConfig } from '../domain/types.ts';
import { logger } from '../util/logger.ts';
import { isInside, sanitizeId } from '../util/paths.ts';
import { run, runOrThrow } from '../util/subprocess.ts';
import { resolveReposDir } from '../registry/synced-registry.ts';
import { syncWorkflowTemplates } from './templates.ts';

export class WorkspaceManager {
  constructor(private cfg: ServiceConfig) {}

  validateRepoTarget(target: RepoTarget): void {
    if (!target.local_path) {
      throw new InvalidWorkspaceCwd(`RepoTarget '${target.repo_alias}' has empty local_path`);
    }
    const baseRepos = resolveReposDir(this.cfg);
    if (!isInside(target.local_path, baseRepos)) {
      throw new InvalidWorkspaceCwd(
        `RepoTarget.local_path (${target.local_path}) MUST be inside ${baseRepos}`,
      );
    }
    if (!existsSync(target.local_path)) {
      throw new RepoCloneError(
        `Base checkout for ${target.repo_alias} does not exist at ${target.local_path}. Run 'gaggle sync' first.`,
      );
    }
    if (!statSync(target.local_path).isDirectory()) {
      throw new RepoCloneError(`Base checkout path is not a directory: ${target.local_path}`);
    }
    if (!existsSync(join(target.local_path, '.git'))) {
      throw new RepoCloneError(`Base checkout is not a git repo: ${target.local_path}`);
    }
  }

  async syncTemplatesIfEnabled(target: RepoTarget): Promise<void> {
    if (!this.cfg.workflow_templates.sync_on_dispatch) return;
    try {
      const { copied, targetDir } = syncWorkflowTemplates(this.cfg, target.local_path);
      logger.debug('Workflow templates synced', {
        repo_alias: target.repo_alias,
        copied,
        target_dir: targetDir,
      });
    } catch (err) {
      logger.warn('Workflow template sync failed (non-fatal)', {
        repo_alias: target.repo_alias,
        error: (err as Error).message,
      });
    }
  }

  async runHook(name: 'before_run' | 'after_run', target: RepoTarget, issue: Issue, attempt: number | null): Promise<void> {
    const script = name === 'before_run' ? this.cfg.hooks.before_run : this.cfg.hooks.after_run;
    if (!script || !script.trim()) return;

    const env: Record<string, string> = {
      GAGGLE_REPO_ALIAS: target.repo_alias,
      GAGGLE_REPO_URL: target.repo_url,
      GAGGLE_ISSUE_ID: issue.id,
      GAGGLE_ISSUE_IDENTIFIER: issue.identifier,
      GAGGLE_ATTEMPT: attempt === null ? 'first' : String(attempt),
    };

    const shell = process.platform === 'win32' ? ['cmd', '/c'] : ['/bin/sh', '-c'];
    const cmd = [...shell, script];

    logger.debug(`Running ${name} hook`, { repo_alias: target.repo_alias });
    const result = await run(cmd, {
      cwd: target.local_path,
      env,
      timeoutMs: this.cfg.hooks.timeout_ms,
    });
    if (result.exitCode !== 0) {
      const msg = `${name} hook exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`;
      if (name === 'before_run') {
        throw new Error(msg);
      } else {
        logger.warn('after_run hook failed (ignored)', {
          repo_alias: target.repo_alias,
          error: msg,
        });
      }
    }
  }

  /**
   * Optional pre-flight: ensure the base checkout is on its default branch's HEAD.
   * The Repo Syncer is the source of truth, but a stale checkout could exist if a sync
   * pass failed. Best-effort: failure is logged, not thrown.
   */
  async refreshBaseCheckout(target: RepoTarget, branch: string): Promise<void> {
    try {
      await runOrThrow(['git', '-C', target.local_path, 'fetch', 'origin', branch]);
    } catch (err) {
      logger.warn('git fetch failed during pre-flight (continuing)', {
        repo_alias: target.repo_alias,
        error: (err as Error).message,
      });
    }
  }

  /** Clean per-issue auxiliary workspace dirs under `workspace.root`, if they exist. */
  cleanAuxiliaryWorkspace(issue_identifier: string): void {
    const root = this.cfg.workspace.root;
    if (!root) return;
    const safeIdent = sanitizeId(issue_identifier);
    if (!existsSync(root)) return;
    try {
      const entries = require('node:fs').readdirSync(root) as string[];
      for (const name of entries) {
        if (name.startsWith(safeIdent + '__')) {
          const full = join(root, name);
          rmSync(full, { recursive: true, force: true });
          logger.info('Cleaned auxiliary workspace', { dir: full });
        }
      }
    } catch (err) {
      logger.debug('Auxiliary cleanup error (ignored)', { error: (err as Error).message });
    }
  }

  ensureAuxRoot(): void {
    if (this.cfg.workspace.root) mkdirSync(this.cfg.workspace.root, { recursive: true });
  }
}
