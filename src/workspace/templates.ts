/**
 * Workflow Template Sync (Section 10.5).
 *
 * Copies all `.yaml`/`.yml` files from `workflow_templates.path` into
 * `<checkout>/.archon/workflows/<target_subdir>/`. Overwrites; never deletes.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
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

  let copied = 0;
  for (const file of listTemplateFiles(sourceDir)) {
    const dest = join(targetDir, basename(file));
    copyFileSync(file, dest);
    copied++;
  }
  return { copied, targetDir };
}
