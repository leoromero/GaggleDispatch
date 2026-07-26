/**
 * Round-trip tests for the YAML files owned by the Repo Syncer
 * (`registry.synced.yaml` and `scaffold_jobs.yaml`).
 */

import { MemoryStore } from '../executor/store/memory.ts';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findScaffoldJob,
  loadScaffoldJobs,
  removeScaffoldJob,
  saveScaffoldJob,
} from '../registry/scaffold-jobs.ts';
import {
  loadSyncedRegistry,
  reposBaseDir,
  writeSyncedRegistry,
} from '../registry/synced-registry.ts';
import type { ScaffoldJob, SyncedRegistry } from '../domain/types.ts';
import { makeSyncedEntry, tmp } from './helpers/fixtures.ts';

describe('synced-registry round-trip', () => {
  test('returns null before the first sync', async () => {
    expect(await loadSyncedRegistry(new MemoryStore())).toBeNull();
  });

  test('write then load preserves repositories and synced_at', async () => {
    const store = new MemoryStore();
    const registry: SyncedRegistry = {
      synced_at: '2026-05-09T12:34:56Z',
      repositories: [
        makeSyncedEntry({ slug: 'a', url: 'https://github.com/o/a' }),
        makeSyncedEntry({ slug: 'b', url: 'https://github.com/o/b', sync_status: 'error', sync_error: 'boom' }),
      ],
    };
    await writeSyncedRegistry(store, registry);

    const loaded = await loadSyncedRegistry(store);
    expect(loaded).not.toBeNull();
    expect(loaded!.synced_at).toBe('2026-05-09T12:34:56Z');
    expect(loaded!.repositories).toHaveLength(2);
    expect(loaded!.repositories[1]!.sync_status).toBe('error');
    expect(loaded!.repositories[1]!.sync_error).toBe('boom');
  });

  test('frontmatter survives the round trip with its components', async () => {
    const store = new MemoryStore();
    await writeSyncedRegistry(store, {
      synced_at: 'now',
      repositories: [
        makeSyncedEntry({
          slug: 'a',
          frontmatter: {
            name: 'a',
            description: 'd',
            default_workflow: 'gaggle/gaggle-fix-issue',
            components: [{ name: 'api', description: 'the api' }],
          },
        }),
      ],
    });
    const loaded = await loadSyncedRegistry(store);
    expect(loaded!.repositories[0]!.frontmatter?.components[0]!.name).toBe('api');
  });

  test('a write replaces the previous registry rather than merging', async () => {
    const store = new MemoryStore();
    await writeSyncedRegistry(store, {
      synced_at: 'first',
      repositories: [makeSyncedEntry({ slug: 'a' }), makeSyncedEntry({ slug: 'b', url: 'https://github.com/o/b' })],
    });
    await writeSyncedRegistry(store, {
      synced_at: 'second',
      repositories: [makeSyncedEntry({ slug: 'a' })],
    });
    const loaded = await loadSyncedRegistry(store);
    expect(loaded!.repositories.map((r) => r.slug)).toEqual(['a']);
  });

  test('reposBaseDir returns base_folder/repos', () => {
    expect(reposBaseDir('/tmp/base').replace(/\\/g, '/')).toBe('/tmp/base/repos');
  });
});

describe('scaffold-jobs round-trip', () => {
  function job(overrides: Partial<ScaffoldJob> = {}): ScaffoldJob {
    return {
      slug: 'repo',
      url: 'https://github.com/o/repo',
      checkout_path: '/tmp/checkouts/repo',
      run_id: null,
      workflow_name: 'gaggle/gaggle-scaffold',
      branch: 'main',
      started_at: '2026-05-09T00:00:00Z',
      last_polled_at: null,
      last_status: 'running',
      pr_url: null,
      last_error: null,
      ...overrides,
    };
  }

  test('returns an empty list before any job is recorded', async () => {
    expect(await loadScaffoldJobs(new MemoryStore())).toEqual({ jobs: [] });
  });

  test('save then load preserves every field', async () => {
    const store = new MemoryStore();
    const j = job({ last_status: 'completed', run_id: 'r-1', pr_url: 'https://github.com/x/y/pull/1' });
    await saveScaffoldJob(store, j);
    const loaded = await loadScaffoldJobs(store);
    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0]!.run_id).toBe('r-1');
    expect(loaded.jobs[0]!.last_status).toBe('completed');
    expect(loaded.jobs[0]!.pr_url).toBe('https://github.com/x/y/pull/1');
  });

  test('saving inserts a new job and replaces an existing one by slug', async () => {
    const store = new MemoryStore();
    await saveScaffoldJob(store, job({ slug: 'a' }));
    await saveScaffoldJob(store, job({ slug: 'b' }));
    expect((await loadScaffoldJobs(store)).jobs).toHaveLength(2);

    await saveScaffoldJob(store, job({ slug: 'a', last_status: 'completed' }));
    const loaded = await loadScaffoldJobs(store);
    expect(loaded.jobs).toHaveLength(2);
    expect(loaded.jobs.find((j) => j.slug === 'a')!.last_status).toBe('completed');
  });

  test('removing drops only the named slug', async () => {
    const store = new MemoryStore();
    await saveScaffoldJob(store, job({ slug: 'a' }));
    await saveScaffoldJob(store, job({ slug: 'b' }));
    await removeScaffoldJob(store, 'a');
    const loaded = await loadScaffoldJobs(store);
    expect(loaded.jobs.map((j) => j.slug)).toEqual(['b']);
  });

  test('findScaffoldJob returns null for an unknown slug', async () => {
    const store = new MemoryStore();
    await saveScaffoldJob(store, job({ slug: 'a' }));
    expect(await findScaffoldJob(store, 'a')).not.toBeNull();
    expect(await findScaffoldJob(store, 'nope')).toBeNull();
  });
});
