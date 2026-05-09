/**
 * WORKFLOW.md loader (Section 5.1, 5.2, 5.3).
 *
 * Parses the YAML front matter and prompt body. The result is a `WorkflowDefinition`
 * (untyped raw config map + prompt template). Use `buildServiceConfig` to apply
 * defaults, $VAR resolution, and validation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import * as YAML from 'yaml';
import {
  MissingWorkflowFile,
  WorkflowFrontMatterNotAMap,
  WorkflowParseError,
} from '../domain/errors.ts';
import type { WorkflowDefinition } from '../domain/types.ts';

/**
 * Matches the opening front-matter delimiter `---` on its own line. The file
 * may begin with a preamble (e.g. an HTML comment banner emitted by
 * `gaggle init` / `gaggle repo add`) — we discard everything before the first
 * such line.
 */
const FRONT_MATTER_OPEN = /(^|\r?\n)---[ \t]*\r?\n/;

export interface LoadOptions {
  /** Explicit path to WORKFLOW.md. Defaults to `<cwd>/WORKFLOW.md`. */
  workflowPath?: string;
  /** Working directory used when `workflowPath` is not absolute. Defaults to process.cwd(). */
  cwd?: string;
}

export function resolveWorkflowPath(opts: LoadOptions = {}): string {
  const cwd = opts.cwd ?? process.cwd();
  const path = opts.workflowPath ?? 'WORKFLOW.md';
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * Load the workflow definition. Does NOT apply defaults or validation;
 * use `buildServiceConfig` for that step.
 */
export function loadWorkflowDefinition(opts: LoadOptions = {}): WorkflowDefinition {
  const path = resolveWorkflowPath(opts);
  if (!existsSync(path)) throw new MissingWorkflowFile(path);

  const text = readFileSync(path, 'utf8');
  const { config, prompt_template } = splitFrontMatter(text);
  return { config, prompt_template, source_path: path };
}

export function splitFrontMatter(text: string): {
  config: Record<string, unknown>;
  prompt_template: string;
} {
  const openMatch = text.match(FRONT_MATTER_OPEN);
  if (!openMatch || openMatch.index === undefined) {
    return { config: {}, prompt_template: text.trim() };
  }
  const afterFirst = text.slice(openMatch.index + openMatch[0].length);
  const closeIdx = afterFirst.search(/\r?\n---\s*(?:\r?\n|$)/);
  if (closeIdx === -1) {
    throw new WorkflowParseError('WORKFLOW.md front matter is missing closing `---` marker');
  }
  const yamlText = afterFirst.slice(0, closeIdx);
  const body = afterFirst.slice(closeIdx).replace(/^\r?\n---\s*(\r?\n|$)/, '');

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (err) {
    throw new WorkflowParseError(
      `Failed to parse WORKFLOW.md YAML front matter: ${(err as Error).message}`,
      err,
    );
  }
  if (parsed === null || parsed === undefined) {
    return { config: {}, prompt_template: body.trim() };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkflowFrontMatterNotAMap();
  }
  return { config: parsed as Record<string, unknown>, prompt_template: body.trim() };
}

export function workflowDirOf(def: WorkflowDefinition): string {
  return dirname(def.source_path);
}
