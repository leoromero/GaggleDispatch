/**
 * Repo Registry Loader (Section 3.1 #3, 4.1.4).
 *
 * Reads `registry.synced.yaml`, builds a `RegistryContext`, watches the file for
 * hot reload. Repositories with `sync_status: ok` are included; others appear in
 * `warnings` only.
 */

import type {
  RegistryComponent,
  RegistryContext,
  RegistryRepo,
  ServiceConfig,
  SyncedRegistryRepoEntry,
} from '../domain/types.ts';
import { logger } from '../util/logger.ts';
import { watchFile, type WatchHandle } from '../config/watcher.ts';
import { loadSyncedRegistry, resolveReposDir, syncedRegistryPath } from './synced-registry.ts';

function buildContext(entries: SyncedRegistryRepoEntry[], synced_at: string, repos_dir: string): RegistryContext {
  const repositories: RegistryRepo[] = [];
  const components: RegistryComponent[] = [];
  const warnings: string[] = [];

  for (const e of entries) {
    if (e.sync_status !== 'ok' || !e.frontmatter) {
      if (e.sync_status === 'missing_gaggle_md') {
        warnings.push(`${e.url}: missing gaggle.md (excluded from analysis)`);
      } else if (e.sync_status === 'error' && e.sync_error) {
        warnings.push(`${e.url}: ${e.sync_error}`);
      }
      continue;
    }
    const repo: RegistryRepo = {
      name: e.frontmatter.name,
      url: e.url,
      local_path: e.local_path,
      description: e.frontmatter.description,
      default_workflow: e.frontmatter.default_workflow,
      available_workflows: e.frontmatter.available_workflows ?? [e.frontmatter.default_workflow],
      components: e.frontmatter.components,
      narrative: e.narrative ?? '',
    };
    repositories.push(repo);
    for (const comp of e.frontmatter.components) {
      components.push({
        ...comp,
        repo_name: repo.name,
        repo_url: repo.url,
        repo_local_path: repo.local_path,
      });
    }
  }

  return { repositories, components, last_synced_at: synced_at, warnings, repos_dir };
}

export interface RegistryLoaderHandle {
  getContext: () => RegistryContext;
  reload: () => void;
  on: (cb: (ctx: RegistryContext) => void) => () => void;
  close: () => Promise<void>;
}

export function startRegistryLoader(cfg: ServiceConfig): RegistryLoaderHandle {
  let lastGood: RegistryContext = { repositories: [], components: [], last_synced_at: new Date(0).toISOString(), warnings: [], repos_dir: resolveReposDir(cfg) };
  const subscribers = new Set<(ctx: RegistryContext) => void>();
  let watcher: WatchHandle | null = null;

  const reload = () => {
    try {
      const data = loadSyncedRegistry(cfg.registry.base_folder);
      if (!data) {
        logger.warn('Synced registry not found; keeping last-known-good context', {
          path: syncedRegistryPath(cfg.registry.base_folder),
        });
        return;
      }
      const ctx = buildContext(data.repositories, data.synced_at, resolveReposDir(cfg));
      lastGood = ctx;
      logger.info('Registry context rebuilt', {
        repos_ok: ctx.repositories.length,
        components: ctx.components.length,
        warnings: ctx.warnings.length,
      });
      for (const cb of subscribers) {
        try {
          cb(ctx);
        } catch (err) {
          logger.error('Registry subscriber error', { error: (err as Error).message });
        }
      }
    } catch (err) {
      logger.error('Registry reload failed; keeping last-known-good context', {
        error: (err as Error).message,
      });
    }
  };

  reload();
  watcher = watchFile(syncedRegistryPath(cfg.registry.base_folder), reload, 250);

  return {
    getContext: () => lastGood,
    reload,
    on: (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    close: async () => {
      if (watcher) await watcher.close();
    },
  };
}
