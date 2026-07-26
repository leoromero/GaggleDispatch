/**
 * Synced Registry I/O (Sections 6.5).
 *
 * Owned exclusively by the Repo Syncer. The Repo Registry Loader reads it.
 *
 * Was `<base_folder>/registry.synced.yaml`. Moving it into Postgres removed a
 * same-process round trip: the syncer wrote the file so that the loader — in
 * the same process — could notice via a filesystem watcher and re-read it.
 */

import { join } from 'node:path';
import type { ServiceConfig, SyncedRegistry } from '../domain/types.ts';
import type { Store } from '../executor/store/types.ts';

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

/**
 * Load the registry the syncer last wrote.
 *
 * Returns null before the first sync, which callers treat as "not synced yet"
 * rather than an error.
 */
export async function loadSyncedRegistry(store: Store): Promise<SyncedRegistry | null> {
  const row = await store.loadSyncedRegistry();
  if (!row) return null;
  return {
    synced_at: row.synced_at,
    repositories: row.repositories.map((r) => ({
      url: r.url,
      slug: r.slug,
      default_branch: r.default_branch,
      local_path: r.local_path,
      last_synced_at: r.last_synced_at,
      last_commit_sha: r.last_commit_sha,
      sync_status: r.sync_status as SyncedRegistry['repositories'][number]['sync_status'],
      sync_error: r.sync_error,
      frontmatter: (r.frontmatter ?? null) as SyncedRegistry['repositories'][number]['frontmatter'],
      narrative: r.narrative,
    })),
  };
}

/**
 * Replace the registry wholesale.
 *
 * One transaction, so a reader never observes a partially-written registry —
 * the atomic-file-write this replaced achieved the same thing by renaming a
 * temp file into place.
 */
export async function writeSyncedRegistry(
  store: Store,
  registry: SyncedRegistry,
): Promise<void> {
  await store.replaceSyncedRegistry(
    registry.synced_at,
    registry.repositories.map((r) => ({
      url: r.url,
      slug: r.slug,
      default_branch: r.default_branch,
      local_path: r.local_path,
      last_synced_at: r.last_synced_at,
      last_commit_sha: r.last_commit_sha,
      sync_status: r.sync_status,
      sync_error: r.sync_error,
      frontmatter: r.frontmatter ?? null,
      narrative: r.narrative,
    })),
  );
}
