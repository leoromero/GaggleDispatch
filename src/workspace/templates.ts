/**
 * Workflow Template Sync (Section 10.5).
 *
 * Copies all `.yaml`/`.yml` files from `workflow_templates.path` into
 * `<checkout>/.gaggle/workflows/<target_subdir>/`.
 *
 * There used to be a second destination: Archon kept a private clone at
 * `~/.archon/workspaces/<owner>/<repo>/source` and cut worktrees from *that*,
 * so templates had to be mirrored into it or a worktree would run a stale
 * workflow. The engine cuts worktrees from this checkout, so the mirror — and
 * the git-remote parsing that located it — is gone.
 *
 * Overwrites; never deletes.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ServiceConfig } from '../domain/types.ts';
import { logger } from '../util/logger.ts';

export function listTemplateFiles(sourceDir: string): string[] {
  if (!existsSync(sourceDir)) return [];
  return readdirSync(sourceDir)
    .map((f) => join(sourceDir, f))
    .filter((f) => statSync(f).isFile() && /\.(ya?ml)$/i.test(f))
    .sort();
}

export function syncWorkflowTemplates(
  cfg: ServiceConfig,
  checkoutPath: string,
): { copied: number; targetDir: string } {
  const sourceDir = cfg.workflow_templates.path;
  const targetDir = join(checkoutPath, '.gaggle', 'workflows', cfg.workflow_templates.target_subdir);

  if (!existsSync(sourceDir)) {
    logger.warn('Workflow template source directory does not exist; skipping sync', {
      source: sourceDir,
    });
    return { copied: 0, targetDir };
  }
  mkdirSync(targetDir, { recursive: true });

  let copied = 0;
  for (const file of listTemplateFiles(sourceDir)) {
    copyFileSync(file, join(targetDir, basename(file)));
    copied++;
  }
  return { copied, targetDir };
}
