/**
 * Workflow Template Sync (Section 10.5).
 *
 * Copies all `.yaml`/`.yml` files from `workflow_templates.path` into:
 *   1. `<checkout>/.archon/workflows/<target_subdir>/`  (GaggleDispatch managed checkout)
 *   2. `~/.archon/workspaces/<owner>/<repo>/source/.archon/workflows/<target_subdir>/`
 *      (Archon's internal source clone, which it uses when creating worktrees)
 *
 * Overwrites; never deletes.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { ServiceConfig } from '../domain/types.ts';
import { logger } from '../util/logger.ts';

export function listTemplateFiles(sourceDir: string): string[] {
  if (!existsSync(sourceDir)) return [];
  return readdirSync(sourceDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .map((name) => join(sourceDir, name))
    .filter((p) => statSync(p).isFile());
}


export function syncWorkflowTemplates(cfg: ServiceConfig, checkoutPath: string): { copied: number; targetDir: string } {
  const sourceDir = cfg.workflow_templates.path;
  const targetDir = join(checkoutPath, '.archon', 'workflows', cfg.workflow_templates.target_subdir);

  if (!existsSync(sourceDir)) {
    logger.warn('Workflow template source directory does not exist; skipping sync', { source: sourceDir });
    return { copied: 0, targetDir };
  }
  mkdirSync(targetDir, { recursive: true });

  // Also sync to Archon's internal source clone so worktrees get the latest templates.
  const archonCloneDir = resolveArchonSourceCloneDir(checkoutPath, cfg.workflow_templates.target_subdir);
  if (archonCloneDir) {
    mkdirSync(archonCloneDir, { recursive: true });
  }

  let copied = 0;
  for (const file of listTemplateFiles(sourceDir)) {
    const name = basename(file);
    copyFileSync(file, join(targetDir, name));
    if (archonCloneDir) {
      copyFileSync(file, join(archonCloneDir, name));
    }
    copied++;
  }
  return { copied, targetDir };
}

/** Resolve Archon's internal source-clone workflow dir for a checkout, by reading the git remote. */
function resolveArchonSourceCloneDir(checkoutPath: string, targetSubdir: string): string | null {
  try {
    const gitConfigPath = join(checkoutPath, '.git', 'config');
    if (!existsSync(gitConfigPath)) return null;
    const cfg = readFileSync(gitConfigPath, 'utf8');
    const m = cfg.match(/\[remote "origin"\][^\[]*url\s*=\s*([^\r\n]+)/s);
    if (!m) return null;
    const url = m[1]!.trim();
    // Match both HTTPS (github.com/owner/repo) and SSH (git@...:owner/repo or git@host:owner/repo)
    const urlM = url.match(/[:/]([^/:]+)\/([^/.]+?)(?:\.git)?$/);
    if (!urlM) return null;
    const [, owner, repo] = urlM;
    return join(homedir(), '.archon', 'workspaces', owner!, repo!, 'source', '.archon', 'workflows', targetSubdir);
  } catch {
    return null;
  }
}
