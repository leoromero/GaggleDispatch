/**
 * symphony.md parser (Section 5.4).
 *
 * Front matter is REQUIRED. The Markdown body following the closing `---` is the
 * `narrative` consumed verbatim by the Issue Analyzer.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as YAML from 'yaml';
import { RepoSyncError } from '../domain/errors.ts';
import type { RepoFrontmatter } from '../domain/types.ts';

const NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export interface ParsedSymphonyMd {
  frontmatter: RepoFrontmatter;
  narrative: string;
}

export function parseSymphonyMd(text: string, source: string): ParsedSymphonyMd {
  const split = splitFrontMatter(text);
  if (!split) {
    throw new RepoSyncError(`${source}: missing YAML front matter (must start with '---')`);
  }
  const { yamlText, body } = split;

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (err) {
    throw new RepoSyncError(`${source}: failed to parse front matter: ${(err as Error).message}`, err);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RepoSyncError(`${source}: front matter must be a YAML map`);
  }

  const fm = parsed as Record<string, unknown>;

  const name = stringField(fm, 'name', source, true);
  if (!NAME_RE.test(name)) {
    throw new RepoSyncError(`${source}: 'name' must match [a-z0-9][a-z0-9-]*[a-z0-9] (got '${name}')`);
  }
  const description = stringField(fm, 'description', source, true);
  const default_workflow = stringField(fm, 'default_workflow', source, true);

  const available_workflows =
    fm.available_workflows === undefined || fm.available_workflows === null
      ? undefined
      : Array.isArray(fm.available_workflows)
      ? fm.available_workflows.map((v, i) => {
          if (typeof v !== 'string') throw new RepoSyncError(`${source}: available_workflows[${i}] must be a string`);
          return v;
        })
      : (() => {
          throw new RepoSyncError(`${source}: available_workflows must be a list of strings`);
        })();

  const componentsRaw = fm.components;
  if (!Array.isArray(componentsRaw) || componentsRaw.length === 0) {
    throw new RepoSyncError(`${source}: 'components' is required and must contain at least one entry`);
  }

  const components = componentsRaw.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new RepoSyncError(`${source}: components[${i}] must be an object`);
    }
    const cmp = c as Record<string, unknown>;
    const cname = stringField(cmp, 'name', `${source}.components[${i}]`, true);
    if (!NAME_RE.test(cname)) {
      throw new RepoSyncError(
        `${source}: components[${i}].name must match [a-z0-9][a-z0-9-]*[a-z0-9] (got '${cname}')`,
      );
    }
    const cdesc = stringField(cmp, 'description', `${source}.components[${i}]`, true);
    return { ...cmp, name: cname, description: cdesc };
  });

  return {
    frontmatter: {
      ...fm,
      name,
      description,
      default_workflow,
      available_workflows,
      components,
    } as RepoFrontmatter,
    narrative: body.trim(),
  };
}

export function readSymphonyMdAt(path: string): ParsedSymphonyMd | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  return parseSymphonyMd(text, path);
}

// ─── helpers ────────────────────────────────────────────────────────────────
function splitFrontMatter(text: string): { yamlText: string; body: string } | null {
  const start = text.match(/^---\s*\r?\n/);
  if (!start) return null;
  const after = text.slice(start[0].length);
  const close = after.search(/\r?\n---\s*(\r?\n|$)/);
  if (close === -1) return null;
  const yamlText = after.slice(0, close);
  const body = after.slice(close).replace(/^\r?\n---\s*(\r?\n|$)/, '');
  return { yamlText, body };
}

function stringField(o: Record<string, unknown>, key: string, source: string, required = false): string {
  const v = o[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new RepoSyncError(`${source}: '${key}' is required`);
    return '';
  }
  if (typeof v !== 'string') throw new RepoSyncError(`${source}: '${key}' must be a string`);
  return v;
}
