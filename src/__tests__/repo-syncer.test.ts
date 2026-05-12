/**
 * Repo Syncer integration test — uses a local bare git repo as the
 * "remote" and a small `gh` shim to satisfy `gh api repos/.../commits/...`
 * without touching the real network.
 *
 * The test is skipped automatically if `git` is not on PATH.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { applyNameCollisions, runSyncPass } from '../registry/repo-syncer.ts';
import { commandExists, run, runOrThrow } from '../util/subprocess.ts';
import { loadSyncedRegistry, syncedRegistryPath } from '../registry/synced-registry.ts';
import type { SyncedRegistryRepoEntry } from '../domain/types.ts';
import { makeServiceConfig, makeSyncedEntry } from './helpers/fixtures.ts';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function asUnixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Create a bare git repository pre-populated with the given files. */
async function makeBareWithFiles(files: Record<string, string>): Promise<{ bare: string; sha: string }> {
  const bare = resolve(tmp('gaggle-bare-'));
  const work = resolve(tmp('gaggle-work-'));

  await runOrThrow(['git', 'init', '--bare', '-b', 'main', bare]);
  await runOrThrow(['git', 'init', '-b', 'main', work]);
  await runOrThrow(['git', '-C', work, 'config', 'user.email', 'test@example.com']);
  await runOrThrow(['git', '-C', work, 'config', 'user.name', 'GaggleTest']);

  for (const [path, content] of Object.entries(files)) {
    const full = join(work, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  await runOrThrow(['git', '-C', work, 'add', '.']);
  await runOrThrow(['git', '-C', work, 'commit', '-m', 'initial']);
  await runOrThrow(['git', '-C', work, 'remote', 'add', 'origin', bare]);
  await runOrThrow(['git', '-C', work, 'push', '-u', 'origin', 'main']);

  const head = await runOrThrow(['git', '-C', work, 'rev-parse', 'HEAD']);
  return { bare, sha: head.stdout.trim() };
}

/**
 * Set up a `gh` shim in `shimDir` that recognizes
 * `gh api repos/<owner>/<repo>/commits/<branch> --jq .sha`
 * and prints the supplied SHA for matching repo URLs.
 */
function writeGhShim(shimDir: string, mapping: Record<string, string>): string {
  mkdirSync(shimDir, { recursive: true });
  const isWindows = process.platform === 'win32';
  const mappingEntries = Object.entries(mapping)
    .map(([k, v]) => `  "${k}": "${v}",`)
    .join('\n');

  // Cross-platform Bun-based shim
  const shimJsPath = join(shimDir, 'gh-shim.mjs');
  writeFileSync(
    shimJsPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const mapping = {
${mappingEntries}
};
if (args[0] === 'api' && args[1] && /^repos\\//.test(args[1])) {
  const m = args[1].match(/^repos\\/([^/]+)\\/([^/]+)\\/commits\\/(.+)$/);
  if (m) {
    const key = m[1] + '/' + m[2];
    const sha = mapping[key];
    if (sha) { process.stdout.write(sha + '\\n'); process.exit(0); }
  }
  process.stderr.write('shim: no mapping for ' + args[1] + '\\n');
  process.exit(2);
}
process.stderr.write('shim: unsupported gh invocation: ' + JSON.stringify(args) + '\\n');
process.exit(2);
`,
  );

  if (isWindows) {
    const ghCmd = join(shimDir, 'gh.cmd');
    writeFileSync(ghCmd, `@echo off\r\nnode "${shimJsPath}" %*\r\n`, 'utf8');
    return ghCmd;
  } else {
    const ghSh = join(shimDir, 'gh');
    writeFileSync(ghSh, `#!/bin/sh\nexec node "${shimJsPath}" "$@"\n`, 'utf8');
    chmodSync(ghSh, 0o755);
    return ghSh;
  }
}

const GAGGLE_MD_OK = `---
name: test-repo
description: A test repo.
default_workflow: gaggle/gaggle-fix-issue
available_workflows:
  - gaggle/gaggle-fix-issue
components:
  - name: test-api
    description: API service.
    component_type: ecs_service
---

Body of the gaggle.md.
`;

let gitOk = false;
let nodeOk = false;
let savedPath = '';
let savedConfigCount: string | undefined;
let savedConfigKey0: string | undefined;
let savedConfigValue0: string | undefined;

beforeAll(async () => {
  gitOk = await commandExists('git');
  nodeOk = await commandExists('node');
  savedPath = process.env.PATH ?? '';
  savedConfigCount = process.env.GIT_CONFIG_COUNT;
  savedConfigKey0 = process.env.GIT_CONFIG_KEY_0;
  savedConfigValue0 = process.env.GIT_CONFIG_VALUE_0;
});

afterAll(() => {
  process.env.PATH = savedPath;
  if (savedConfigCount !== undefined) process.env.GIT_CONFIG_COUNT = savedConfigCount;
  else delete process.env.GIT_CONFIG_COUNT;
  if (savedConfigKey0 !== undefined) process.env.GIT_CONFIG_KEY_0 = savedConfigKey0;
  else delete process.env.GIT_CONFIG_KEY_0;
  if (savedConfigValue0 !== undefined) process.env.GIT_CONFIG_VALUE_0 = savedConfigValue0;
  else delete process.env.GIT_CONFIG_VALUE_0;
});

describe('Repo Syncer integration', () => {
  test('end-to-end: clones, parses gaggle.md, writes registry.synced.yaml', async () => {
    if (!gitOk || !nodeOk) {
      // Cannot run without git + node available in PATH
      return;
    }

    const { bare, sha } = await makeBareWithFiles({ 'gaggle.md': GAGGLE_MD_OK });

    const shimDir = resolve(tmp('gaggle-shim-'));
    writeGhShim(shimDir, { 'test-org/test-repo': sha });

    const baseFolder = resolve(tmp('gaggle-base-'));
    const cfg = makeServiceConfig({
      registry: {
        base_folder: baseFolder,
        sync_interval_ms: 0,
        sync_on_startup: false,
        analysis_cache_ttl_ms: 0, auto_scaffold: false,
      },
      repositories: [{ url: 'https://github.com/test-org/test-repo', default_branch: 'main' }],
    });

    const sep = process.platform === 'win32' ? ';' : ':';
    process.env.PATH = `${shimDir}${sep}${savedPath}`;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'url.' + asUnixPath(bare) + '.insteadOf';
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/test-org/test-repo';

    const result = await runSyncPass(cfg, { quiet: true });
    expect(result.ok).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.missing).toBe(0);

    const entry = result.per_repo[0]!;
    expect(entry.sync_status).toBe('ok');
    expect(entry.last_commit_sha).toBe(sha);
    expect(entry.frontmatter?.name).toBe('test-repo');
    expect(entry.frontmatter?.components[0]!.name).toBe('test-api');

    const persisted = loadSyncedRegistry(baseFolder);
    expect(persisted!.repositories[0]!.frontmatter?.name).toBe('test-repo');
    expect(existsSync(syncedRegistryPath(baseFolder))).toBe(true);
  });

  test('end-to-end: missing gaggle.md results in sync_status=missing_gaggle_md', async () => {
    if (!gitOk || !nodeOk) return;

    const { bare, sha } = await makeBareWithFiles({ 'README.md': '# only a readme' });
    const shimDir = resolve(tmp('gaggle-shim-'));
    writeGhShim(shimDir, { 'test-org/no-gaggle': sha });

    const baseFolder = resolve(tmp('gaggle-base-'));
    const cfg = makeServiceConfig({
      registry: { base_folder: baseFolder, sync_interval_ms: 0, sync_on_startup: false, analysis_cache_ttl_ms: 0, auto_scaffold: false },
      repositories: [{ url: 'https://github.com/test-org/no-gaggle', default_branch: 'main' }],
    });

    const sep = process.platform === 'win32' ? ';' : ':';
    process.env.PATH = `${shimDir}${sep}${savedPath}`;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'url.' + asUnixPath(bare) + '.insteadOf';
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/test-org/no-gaggle';

    const result = await runSyncPass(cfg, { quiet: true });
    expect(result.missing).toBe(1);
    expect(result.per_repo[0]!.sync_status).toBe('missing_gaggle_md');
    expect(result.per_repo[0]!.sync_error).toMatch(/No gaggle.md/i);
  });

  test('end-to-end: gh failure → sync_status=error and other repos still processed', async () => {
    if (!gitOk || !nodeOk) return;

    const okBuild = await makeBareWithFiles({ 'gaggle.md': GAGGLE_MD_OK });
    // Second repo: gh shim DELIBERATELY does not include this repo's mapping → exits 2.
    const shimDir = resolve(tmp('gaggle-shim-'));
    writeGhShim(shimDir, { 'test-org/test-repo': okBuild.sha });

    const baseFolder = resolve(tmp('gaggle-base-'));
    const cfg = makeServiceConfig({
      registry: { base_folder: baseFolder, sync_interval_ms: 0, sync_on_startup: false, analysis_cache_ttl_ms: 0, auto_scaffold: false },
      repositories: [
        { url: 'https://github.com/test-org/test-repo', default_branch: 'main' },
        { url: 'https://github.com/test-org/missing-repo', default_branch: 'main' },
      ],
    });

    const sep = process.platform === 'win32' ? ';' : ':';
    process.env.PATH = `${shimDir}${sep}${savedPath}`;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'url.' + asUnixPath(okBuild.bare) + '.insteadOf';
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/test-org/test-repo';

    const result = await runSyncPass(cfg, { quiet: true });
    expect(result.ok).toBe(1);
    expect(result.errors).toBe(1);
    const errEntry = result.per_repo.find((r) => r.url.includes('missing-repo'))!;
    expect(errEntry.sync_status).toBe('error');
    expect(errEntry.sync_error).toMatch(/gh api/i);
  });

  test('runSyncPass throws RepoSyncError when two repos derive the same slug', async () => {
    if (!gitOk || !nodeOk) return;
    // No bare repo / shim needed — slug collision throws BEFORE network calls.
    // But ensureGhAvailable is called first and would succeed (real gh in PATH).
    const baseFolder = resolve(tmp('gaggle-base-'));
    const cfg = makeServiceConfig({
      registry: { base_folder: baseFolder, sync_interval_ms: 0, sync_on_startup: false, analysis_cache_ttl_ms: 0, auto_scaffold: false },
      repositories: [
        { url: 'https://github.com/org-a/dup', default_branch: 'main' },
        { url: 'https://github.com/org-b/dup', default_branch: 'main' },
      ],
    });
    await expect(runSyncPass(cfg, { quiet: true })).rejects.toThrow(/same slug/i);
  });
});

describe('applyNameCollisions edge cases', () => {
  test('returns empty for empty input', () => {
    expect(applyNameCollisions([])).toEqual([]);
  });

  test('passes through entries that are not status=ok', () => {
    const entries: SyncedRegistryRepoEntry[] = [
      makeSyncedEntry({ slug: 'a', sync_status: 'error', frontmatter: null }),
      makeSyncedEntry({ slug: 'b', sync_status: 'missing_gaggle_md', frontmatter: null }),
    ];
    const out = applyNameCollisions(entries);
    expect(out[0]!.sync_status).toBe('error');
    expect(out[1]!.sync_status).toBe('missing_gaggle_md');
  });

  test('flags only the LATER duplicate when two repos share a name', () => {
    const a = makeSyncedEntry({ slug: 'a', url: 'https://x/a', frontmatter: { name: 'shared', description: '', default_workflow: '', available_workflows: [], components: [] } });
    const b = makeSyncedEntry({ slug: 'b', url: 'https://x/b', frontmatter: { name: 'shared', description: '', default_workflow: '', available_workflows: [], components: [] } });
    const out = applyNameCollisions([a, b]);
    expect(out[0]!.sync_status).toBe('ok');
    expect(out[1]!.sync_status).toBe('error');
    expect(out[1]!.sync_error).toMatch(/Repository name collision/);
  });

  test('flags duplicate component names across two repos', () => {
    const a = makeSyncedEntry({ slug: 'a', url: 'https://x/a', frontmatter: { name: 'a', description: '', default_workflow: '', available_workflows: [], components: [{ name: 'shared-svc', description: '' }] } });
    const b = makeSyncedEntry({ slug: 'b', url: 'https://x/b', frontmatter: { name: 'b', description: '', default_workflow: '', available_workflows: [], components: [{ name: 'shared-svc', description: '' }] } });
    const out = applyNameCollisions([a, b]);
    expect(out[1]!.sync_status).toBe('error');
    expect(out[1]!.sync_error).toMatch(/Component name collision/);
  });

  test('preserves order of input entries', () => {
    const a = makeSyncedEntry({ slug: 'a', url: 'https://x/a', frontmatter: { name: 'a', description: '', default_workflow: '', available_workflows: [], components: [] } });
    const b = makeSyncedEntry({ slug: 'b', url: 'https://x/b', frontmatter: { name: 'b', description: '', default_workflow: '', available_workflows: [], components: [] } });
    const c = makeSyncedEntry({ slug: 'c', url: 'https://x/c', frontmatter: { name: 'c', description: '', default_workflow: '', available_workflows: [], components: [] } });
    const out = applyNameCollisions([a, b, c]);
    expect(out.map((e) => e.slug)).toEqual(['a', 'b', 'c']);
  });
});
