/**
 * Round-trip tests for the YAML files owned by the Repo Syncer
 * (`registry.synced.yaml` and `scaffold_jobs.yaml`).
 */

import { MemoryStore } from '../executor/store/memory.ts';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SyncedRegistryParseError } from '../domain/errors.ts';
import {
  findScaffoldJob,
  loadScaffoldJobs,
  removeScaffoldJob,
  saveScaffoldJob,
} from '../registry/scaffold-jobs.ts';
import {
  loadSyncedRegistry,
  reposBaseDir,
  syncedRegistryPath,
  writeSyncedRegistry,
} from '../registry/synced-registry.ts';
import type { ScaffoldJob, SyncedRegistry } from '../domain/types.ts';
import { makeSyncedEntry, tmp } from './helpers/fixtures.ts';

describe('synced-registry round-trip', () => {
  test('returns null when file does not exist', () => {
    const dir = tmp();
    expect(loadSyncedRegistry(dir)).toBeNull();
  });

  test('write then load preserves repositories and synced_at', () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const registry: SyncedRegistry = {
      synced_at: '2026-05-09T12:34:56Z',
      repositories: [
        makeSyncedEntry({ slug: 'a', url: 'https://github.com/o/a' }),
        makeSyncedEntry({ slug: 'b', url: 'https://github.com/o/b', sync_status: 'error', sync_error: 'boom' }),
      ],
    };
    writeSyncedRegistry(dir, registry);
    const loaded = loadSyncedRegistry(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.synced_at).toBe('2026-05-09T12:34:56Z');
    expect(loaded!.repositories.length).toBe(2);
    expect(loaded!.repositories[1]!.sync_status).toBe('error');
    expect(loaded!.repositories[1]!.sync_error).toBe('boom');
  });

  test('writes the AUTO-GENERATED banner', () => {
    const dir = tmp();
    writeSyncedRegistry(dir, { synced_at: 'now', repositories: [] });
    const text = readFileSync(syncedRegistryPath(dir), 'utf8');
    expect(text).toMatch(/AUTO-GENERATED/);
  });

  test('throws SyncedRegistryParseError on malformed YAML', () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(syncedRegistryPath(dir), 'not: : valid: yaml: ::\n  - bad');
    expect(() => loadSyncedRegistry(dir)).toThrow(SyncedRegistryParseError);
  });

  test('throws SyncedRegistryParseError on empty file', () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(syncedRegistryPath(dir), '');
    expect(() => loadSyncedRegistry(dir)).toThrow(SyncedRegistryParseError);
  });

  test('reposBaseDir returns base_folder/repos', () => {
    expect(reposBaseDir('/tmp/base').replace(/\\/g, '/')).toBe('/tmp/base/repos');
  });

  test('write is atomic (no temp files left behind)', () => {
    const dir = tmp();
    writeSyncedRegistry(dir, { synced_at: 'x', repositories: [] });
    // The atomic writer should only leave the final file
    const path = syncedRegistryPath(dir);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(path + '.tmp')).toBe(false);
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
