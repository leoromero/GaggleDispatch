/**
 * Resolving a workflow name to a document.
 *
 * A workflow's identity is its `name:` field, not its path — templates are
 * namespaced (`gaggle/gaggle-fix-issue`) and live in nested folders, but a
 * repo is free to override one by declaring the same name anywhere on the
 * search path. Earlier search roots win, so a repo-local definition always
 * beats a synced template.
 */

import { join } from 'node:path';
import { logger } from '../../util/logger.ts';
import { discoverWorkflowFiles, loadWorkflowFile, WorkflowLoadError } from './loader.ts';
import type { Diagnostic, WorkflowDef } from './schema.ts';

export interface WorkflowEntry {
  name: string;
  description: string;
  path: string;
  workflow: WorkflowDef;
  warnings: Diagnostic[];
}

export interface RegistryScan {
  entries: WorkflowEntry[];
  /** Files that failed to load, so `workflow list` can report them. */
  failures: { path: string; error: string; diagnostics: Diagnostic[] }[];
}

/**
 * Search roots for a checkout, in precedence order.
 *
 * `.archon/workflows` is not consulted — the cut to `.gaggle/` is clean, and a
 * silent fallback would let a stale Archon-era workflow shadow its replacement.
 */
export function workflowSearchPaths(checkout: string, extraDirs: string[] = []): string[] {
  return [join(checkout, '.gaggle', 'workflows'), ...extraDirs];
}

export function scanWorkflows(searchPaths: string[]): RegistryScan {
  const entries: WorkflowEntry[] = [];
  const failures: RegistryScan['failures'] = [];
  const claimed = new Set<string>();

  for (const dir of searchPaths) {
    for (const path of discoverWorkflowFiles(dir)) {
      try {
        const { workflow, warnings } = loadWorkflowFile(path);
        if (claimed.has(workflow.name)) {
          // An earlier search root already provided this name; that one wins.
          logger.debug('Workflow shadowed by higher-precedence definition', {
            name: workflow.name,
            ignored: path,
          });
          continue;
        }
        claimed.add(workflow.name);
        entries.push({
          name: workflow.name,
          description: workflow.description,
          path,
          workflow,
          warnings,
        });
      } catch (err) {
        failures.push({
          path,
          error: (err as Error).message,
          diagnostics: err instanceof WorkflowLoadError ? err.diagnostics : [],
        });
      }
    }
  }

  return { entries, failures };
}

export class WorkflowNotFoundError extends Error {
  constructor(name: string, available: string[]) {
    const hint =
      available.length > 0
        ? ` Available: ${available.sort().join(', ')}`
        : ' No workflows were found on the search path.';
    super(`workflow '${name}' not found.${hint}`);
    this.name = 'WorkflowNotFoundError';
  }
}

export function resolveWorkflow(name: string, searchPaths: string[]): WorkflowEntry {
  const { entries } = scanWorkflows(searchPaths);
  const hit = entries.find((e) => e.name === name);
  if (!hit) throw new WorkflowNotFoundError(name, entries.map((e) => e.name));
  return hit;
}
