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
import { loadSyncedRegistry, resolveReposDir } from './synced-registry.ts';
import type { Store } from '../executor/store/types.ts';

/** How often to check whether another process ran a sync. */
const REGISTRY_POLL_MS = 5_000;

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

export function startRegistryLoader(cfg: ServiceConfig, store: Store): RegistryLoaderHandle {
  let lastGood: RegistryContext = { repositories: [], components: [], last_synced_at: new Date(0).toISOString(), warnings: [], repos_dir: resolveReposDir(cfg) };
  const subscribers = new Set<(ctx: RegistryContext) => void>();

  const reload = async () => {
    try {
      const data = await loadSyncedRegistry(store);
      if (!data) {
        logger.warn('Synced registry is empty; keeping last-known-good context');
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

  void reload();

  // Poll the sync marker rather than watching a file.
  //
  // The watcher this replaced was mostly the process notifying itself: the
  // syncer and this loader run in the same process, so a write here came back
  // as a filesystem event 250 ms later. The case that genuinely needs
  // noticing is a `gaggle sync` run in another process, and a single-row read
  // on the existing pool covers that. (Bun's SQL driver has no LISTEN/NOTIFY,
  // so a push channel would mean taking on another Postgres client.)
  let lastSyncedAt: string | null = null;
  const poll = async () => {
    try {
      const at = await store.registrySyncedAt();
      if (at && at !== lastSyncedAt) {
        lastSyncedAt = at;
        await reload();
      }
    } catch (err) {
      logger.debug('Registry sync poll failed', { error: (err as Error).message });
    }
  };
  const timer = setInterval(() => void poll(), REGISTRY_POLL_MS);

  return {
    getContext: () => lastGood,
    reload: () => void reload(),
    on: (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    close: async () => {
      clearInterval(timer);
    },
  };
}
