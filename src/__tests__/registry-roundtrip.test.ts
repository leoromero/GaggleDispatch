/**
 * Round-trip tests for the YAML files owned by the Repo Syncer
 * (`registry.synced.yaml` and `scaffold_jobs.yaml`).
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SyncedRegistryParseError } from '../domain/errors.ts';
import {
  loadScaffoldJobs,
  removeJobBySlug,
  scaffoldJobsPath,
  upsertJob,
  writeScaffoldJobs,
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
      archon_run_id: null,
      workflow_name: 'symphony/symphony-scaffold',
      branch: 'main',
      started_at: '2026-05-09T00:00:00Z',
      last_polled_at: null,
      last_status: 'running',
      pr_url: null,
      last_error: null,
      ...overrides,
    };
  }

  test('returns empty {jobs: []} when file is absent', () => {
    const dir = tmp();
    expect(loadScaffoldJobs(dir)).toEqual({ jobs: [] });
  });

  test('write then load preserves all fields', () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const j = job({ last_status: 'completed', archon_run_id: 'r-1', pr_url: 'https://github.com/x/y/pull/1' });
    writeScaffoldJobs(dir, { jobs: [j] });
    const loaded = loadScaffoldJobs(dir);
    expect(loaded.jobs.length).toBe(1);
    expect(loaded.jobs[0]!.archon_run_id).toBe('r-1');
    expect(loaded.jobs[0]!.last_status).toBe('completed');
    expect(loaded.jobs[0]!.pr_url).toBe('https://github.com/x/y/pull/1');
  });

  test('writes a banner', () => {
    const dir = tmp();
    writeScaffoldJobs(dir, { jobs: [] });
    const text = readFileSync(scaffoldJobsPath(dir), 'utf8');
    expect(text).toMatch(/AUTO-GENERATED/);
  });

  test('upsertJob inserts new + replaces by slug', () => {
    const file = { jobs: [job({ slug: 'a' })] };
    const after1 = upsertJob(file, job({ slug: 'b' }));
    expect(after1.jobs.length).toBe(2);
    const after2 = upsertJob(after1, job({ slug: 'a', last_status: 'completed' }));
    expect(after2.jobs.length).toBe(2);
    expect(after2.jobs.find((j) => j.slug === 'a')!.last_status).toBe('completed');
  });

  test('removeJobBySlug filters out matching slug', () => {
    const file = { jobs: [job({ slug: 'a' }), job({ slug: 'b' })] };
    const after = removeJobBySlug(file, 'a');
    expect(after.jobs.length).toBe(1);
    expect(after.jobs[0]!.slug).toBe('b');
  });

  test('upsertJob is pure (does not mutate input)', () => {
    const original = { jobs: [job({ slug: 'a' })] };
    upsertJob(original, job({ slug: 'b' }));
    expect(original.jobs.length).toBe(1);
  });

  test('handles malformed YAML gracefully (returns empty)', () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'scaffold_jobs.yaml'), 'jobs: not-an-array\nfoo: 123\n');
    const loaded = loadScaffoldJobs(dir);
    expect(loaded.jobs).toEqual([]);
  });
});
