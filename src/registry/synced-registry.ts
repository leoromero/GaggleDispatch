/**
 * Synced Registry I/O (Sections 6.5).
 *
 * Owned exclusively by the Repo Syncer. The Repo Registry Loader reads it.
 * File location: `<base_folder>/registry.synced.yaml`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { SyncedRegistryParseError } from '../domain/errors.ts';
import type { ServiceConfig, SyncedRegistry } from '../domain/types.ts';
import { writeFileAtomic } from '../util/fs.ts';

export function syncedRegistryPath(baseFolder: string): string {
  return join(baseFolder, 'registry.synced.yaml');
}

export function reposBaseDir(baseFolder: string): string {
  return join(baseFolder, 'repos');
}

/**
 * Resolve the directory where repo checkouts live, honouring `registry.repos_path`
 * when set (allows reuse of existing developer checkouts without duplicate clones).
 */
export function resolveReposDir(cfg: ServiceConfig): string {
  return cfg.registry.repos_path ?? reposBaseDir(cfg.registry.base_folder);
}

export function loadSyncedRegistry(baseFolder: string): SyncedRegistry | null {
  const path = syncedRegistryPath(baseFolder);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (err) {
    throw new SyncedRegistryParseError(`Failed to parse ${path}: ${(err as Error).message}`, err);
  }
  if (parsed === null || parsed === undefined) {
    throw new SyncedRegistryParseError(`Synced registry at ${path} is empty`);
  }
  if (typeof parsed !== 'object') {
    throw new SyncedRegistryParseError(`Synced registry at ${path} is not a YAML map`);
  }
  const obj = parsed as Record<string, unknown>;
  const synced_at = typeof obj.synced_at === 'string' ? obj.synced_at : new Date(0).toISOString();
  const repositories = Array.isArray(obj.repositories) ? obj.repositories : [];
  return {
    synced_at,
    repositories: repositories as SyncedRegistry['repositories'],
  };
}

export function writeSyncedRegistry(baseFolder: string, registry: SyncedRegistry): void {
  const path = syncedRegistryPath(baseFolder);
  const yaml = YAML.stringify(registry, { lineWidth: 0 });
  const banner =
    '# AUTO-GENERATED — do not hand-edit. Owned by the GaggleDispatch Repo Syncer.\n' +
    '# Re-run `gaggle sync` (or restart the orchestrator) to refresh.\n';
  writeFileAtomic(path, banner + yaml);
}
