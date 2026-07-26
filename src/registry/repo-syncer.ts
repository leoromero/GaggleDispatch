/**
 * Repo Syncer (Section 3.1 #4, 6.6, 6.7, 6.8).
 *
 * Maintains `<base_folder>/repos/<slug>/` clones and writes
 * `<base_folder>/registry.synced.yaml` atomically. Validates name uniqueness
 * (repository alias + component names). Per-repo failures are captured as
 * `sync_status` and do NOT abort the pass.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { RepoSyncError } from '../domain/errors.ts';
import type { Store } from '../executor/store/types.ts';
import type {
  ServiceConfig,
  SourceRegistryEntry,
  SyncedRegistry,
  SyncedRegistryRepoEntry,
} from '../domain/types.ts';
import { logger } from '../util/logger.ts';
import { commandExists, run, runOrThrow } from '../util/subprocess.ts';
import { deriveRepoSlug, parseGithubOwnerRepo } from '../util/paths.ts';
import { readGaggleMdAt } from './gaggle-md.ts';
import { loadSyncedRegistry, reposBaseDir, resolveReposDir, writeSyncedRegistry } from './synced-registry.ts';
import { withLock } from '../util/lock.ts';

export interface SyncOptions {
  /** Where the synced registry is written. */
  store: Store;
  /** Sync only the given slug (others are left as-is). */
  onlySlug?: string;
  /** Quiet mode for CLI: suppress per-repo info logs. */
  quiet?: boolean;
}

export interface SyncResult {
  registry: SyncedRegistry;
  ok: number;
  errors: number;
  missing: number;
  per_repo: SyncedRegistryRepoEntry[];
}

export async function ensureGhAvailable(): Promise<void> {
  if (!(await commandExists('gh'))) {
    throw new RepoSyncError("'gh' CLI not found in PATH. Install via https://cli.github.com/.");
  }
}

async function getRemoteSha(url: string, branch: string): Promise<string> {
  const { owner, repo } = parseGithubOwnerRepo(url);
  const r = await run(['gh', 'api', `repos/${owner}/${repo}/commits/${branch}`, '--jq', '.sha']);
  if (r.exitCode !== 0) {
    throw new RepoSyncError(`gh api failed for ${url}@${branch}: ${r.stderr.trim().slice(0, 500)}`);
  }
  const sha = r.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new RepoSyncError(`gh api returned invalid SHA '${sha}' for ${url}@${branch}`);
  }
  return sha;
}

async function gitClone(url: string, branch: string, dest: string): Promise<void> {
  // SSH URLs (git@<host>:owner/repo) are cloned directly so the caller's SSH
  // host alias (e.g. github-trabajo) and its corresponding identity file are
  // honoured exactly as configured in ~/.ssh/config.
  if (/^git@/i.test(url)) {
    await runOrThrow(['git', 'clone', '--branch', branch, url, dest]);
    return;
  }
  // HTTPS: use `gh repo clone` so private repositories work with the user's
  // existing gh auth. Falls back to plain `git clone` when gh is unavailable
  // (e.g. inside test sandboxes that shim gh to satisfy `gh api` only).
  const { owner, repo } = parseGithubOwnerRepo(url);
  const ghAvailable = await commandExists('gh');
  if (ghAvailable) {
    const result = await run(['gh', 'repo', 'clone', `${owner}/${repo}`, dest, '--', '--branch', branch]);
    if (result.exitCode === 0) return;
    // gh shim or unsupported invocation → fall through to git clone
  }
  await runOrThrow(['git', 'clone', '--branch', branch, url, dest]);
}

async function gitPullFf(checkout: string, branch: string): Promise<void> {
  await runOrThrow(['git', '-C', checkout, 'fetch', 'origin', branch]);
  await runOrThrow(['git', '-C', checkout, 'reset', '--hard', `origin/${branch}`]);
}

async function gitCurrentSha(checkout: string): Promise<string | null> {
  const r = await run(['git', '-C', checkout, 'rev-parse', 'HEAD']);
  if (r.exitCode !== 0) return null;
  return r.stdout.trim();
}

function detectStack(localPath: string): 'node' | 'python' | 'rust' | 'go' | 'unknown' {
  if (existsSync(join(localPath, 'package.json'))) return 'node';
  if (
    existsSync(join(localPath, 'pyproject.toml')) ||
    existsSync(join(localPath, 'setup.py')) ||
    existsSync(join(localPath, 'requirements.txt'))
  )
    return 'python';
  if (existsSync(join(localPath, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(localPath, 'go.mod'))) return 'go';
  return 'unknown';
}

const VALIDATE_SCRIPTS: Record<string, string> = {
  node: `#!/usr/bin/env bash
# .gaggle/validate.sh — run by GaggleDispatch after each implementation pass.
# Commit this file so all agents use the same validation commands.
set -euo pipefail
if [ -f bun.lockb ]; then runner=bun
elif [ -f pnpm-lock.yaml ]; then runner=pnpm
elif [ -f yarn.lock ]; then runner=yarn
else runner=npm; fi
echo "[validate] package manager: $runner"
$runner run type-check 2>/dev/null || $runner run typecheck 2>/dev/null || echo "[validate] no type-check script, skipping"
$runner run lint 2>/dev/null || echo "[validate] no lint script, skipping"
$runner test
`,
  python: `#!/usr/bin/env bash
# .gaggle/validate.sh — run by GaggleDispatch after each implementation pass.
# Commit this file so all agents use the same validation commands.
set -euo pipefail
echo "[validate] running Python tests"
if command -v pytest &>/dev/null; then
  pytest
else
  python -m pytest
fi
`,
  rust: `#!/usr/bin/env bash
# .gaggle/validate.sh — run by GaggleDispatch after each implementation pass.
# Commit this file so all agents use the same validation commands.
set -euo pipefail
echo "[validate] running Rust checks"
cargo check
cargo test
`,
  go: `#!/usr/bin/env bash
# .gaggle/validate.sh — run by GaggleDispatch after each implementation pass.
# Commit this file so all agents use the same validation commands.
set -euo pipefail
echo "[validate] running Go tests"
go build ./...
go test ./...
`,
  unknown: `#!/usr/bin/env bash
# .gaggle/validate.sh — run by GaggleDispatch after each implementation pass.
# Commit this file and replace this placeholder with your actual test commands.
set -euo pipefail
echo "[validate] no stack detected — edit .gaggle/validate.sh with your test commands"
exit 1
`,
};

function ensureValidateScript(localPath: string, slug: string, quiet: boolean): void {
  const gaggleDir = join(localPath, '.gaggle');
  const scriptPath = join(gaggleDir, 'validate.sh');
  if (existsSync(scriptPath)) return;

  const stack = detectStack(localPath);
  mkdirSync(gaggleDir, { recursive: true });
  writeFileSync(scriptPath, VALIDATE_SCRIPTS[stack]!, { encoding: 'utf8' });
  try {
    chmodSync(scriptPath, 0o755);
  } catch {
    // chmod may fail on Windows — non-fatal
  }
  logger.info('Created .gaggle/validate.sh', { slug, stack, path: scriptPath });
  if (!quiet) {
    console.log(
      `  ✓ Created .gaggle/validate.sh for ${slug} (stack: ${stack})` +
        ` — review and commit it to the repo so agents always use the same commands.`,
    );
  }
}

interface ProcessResult {
  entry: SyncedRegistryRepoEntry;
}

async function processRepository(
  cfg: ServiceConfig,
  src: SourceRegistryEntry,
  prior: SyncedRegistryRepoEntry | undefined,
  quiet: boolean,
): Promise<ProcessResult> {
  const slug = deriveRepoSlug(src.url);
  const local_path = join(resolveReposDir(cfg), slug);

  const baseEntry: SyncedRegistryRepoEntry = {
    url: src.url,
    default_branch: src.default_branch,
    slug,
    local_path,
    last_synced_at: prior?.last_synced_at ?? null,
    last_commit_sha: prior?.last_commit_sha ?? null,
    sync_status: 'pending',
    sync_error: null,
    frontmatter: prior?.frontmatter ?? null,
    narrative: prior?.narrative ?? null,
  };

  try {
    let remoteSha: string;
    try {
      remoteSha = await getRemoteSha(src.url, src.default_branch);
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn('Remote SHA fetch failed; keeping last-known-good entry', { url: src.url, error: msg });
      return {
        entry: { ...baseEntry, sync_status: 'error', sync_error: msg },
      };
    }

    if (!existsSync(local_path)) {
      mkdirSync(resolveReposDir(cfg), { recursive: true });
      if (!quiet) logger.info('Cloning repository', { url: src.url, branch: src.default_branch, dest: local_path });
      await gitClone(src.url, src.default_branch, local_path);
    } else if (prior?.last_commit_sha !== remoteSha) {
      if (!quiet) logger.info('Pulling repository', { url: src.url, branch: src.default_branch });
      try {
        await gitPullFf(local_path, src.default_branch);
      } catch (err) {
        const msg = (err as Error).message;
        return { entry: { ...baseEntry, sync_status: 'error', sync_error: `git pull --ff-only failed: ${msg}` } };
      }
    } else if (!quiet) {
      logger.debug('Repository up-to-date', { url: src.url, sha: remoteSha });
    }

    const headSha = (await gitCurrentSha(local_path)) ?? remoteSha;

    const gagglePath = join(local_path, 'gaggle.md');
    if (!existsSync(gagglePath)) {
      return {
        entry: {
          ...baseEntry,
          last_synced_at: new Date().toISOString(),
          last_commit_sha: headSha,
          sync_status: 'missing_gaggle_md',
          sync_error: 'No gaggle.md found at repository root.',
          frontmatter: null,
          narrative: null,
        },
      };
    }

    let parsed;
    try {
      parsed = readGaggleMdAt(gagglePath);
    } catch (err) {
      const msg = (err as Error).message;
      return {
        entry: {
          ...baseEntry,
          last_synced_at: new Date().toISOString(),
          last_commit_sha: headSha,
          sync_status: 'error',
          sync_error: msg,
        },
      };
    }
    if (!parsed) {
      return {
        entry: {
          ...baseEntry,
          last_synced_at: new Date().toISOString(),
          last_commit_sha: headSha,
          sync_status: 'missing_gaggle_md',
          sync_error: 'gaggle.md present but unreadable',
        },
      };
    }

    ensureValidateScript(local_path, slug, quiet);

    return {
      entry: {
        ...baseEntry,
        last_synced_at: new Date().toISOString(),
        last_commit_sha: headSha,
        sync_status: 'ok',
        sync_error: null,
        frontmatter: parsed.frontmatter,
        narrative: parsed.narrative,
      },
    };
  } catch (err) {
    return {
      entry: {
        ...baseEntry,
        sync_status: 'error',
        sync_error: (err as Error).message,
      },
    };
  }
}

/** Validate uniqueness of repo `name` and component `name` across the merged set. */
export function applyNameCollisions(entries: SyncedRegistryRepoEntry[]): SyncedRegistryRepoEntry[] {
  const seenRepoName = new Map<string, string>(); // name -> winner URL
  const seenComponent = new Map<string, string>(); // component name -> winner URL

  return entries.map((e) => {
    if (e.sync_status !== 'ok' || !e.frontmatter) return e;

    const repoName = e.frontmatter.name;
    if (seenRepoName.has(repoName)) {
      const winner = seenRepoName.get(repoName)!;
      const msg =
        `Repository name collision: "${repoName}" is already used by ${winner} (winner). ` +
        `Resolution: rename the 'name' field in this repository's gaggle.md.`;
      logger.error(msg, { url: e.url });
      return { ...e, sync_status: 'error', sync_error: msg };
    }
    seenRepoName.set(repoName, e.url);

    for (const c of e.frontmatter.components) {
      if (seenComponent.has(c.name)) {
        const winner = seenComponent.get(c.name)!;
        const msg =
          `Component name collision: "${c.name}" is declared by both "${winner}" (winner) and ` +
          `"${e.frontmatter.name}" (this repository, ${e.url}). ` +
          `Resolution: rename the component in this repository's gaggle.md to a unique name.`;
        logger.error(msg, { url: e.url });
        return { ...e, sync_status: 'error', sync_error: msg };
      }
    }
    for (const c of e.frontmatter.components) {
      seenComponent.set(c.name, e.url);
    }
    return e;
  });
}

/** Run a single Repo Syncer pass. Holds the file lock for the write step. */
export async function runSyncPass(cfg: ServiceConfig, opts: SyncOptions): Promise<SyncResult> {
  await ensureGhAvailable();
  mkdirSync(cfg.registry.base_folder, { recursive: true });
  mkdirSync(resolveReposDir(cfg), { recursive: true });

  const store = opts.store;
  const prior = await loadSyncedRegistry(store);
  const priorBySlug = new Map<string, SyncedRegistryRepoEntry>();
  if (prior) for (const r of prior.repositories) priorBySlug.set(r.slug, r);

  // Detect duplicate slugs at sync time (Section 5.3.10 + 6.6 last row).
  const slugs = new Set<string>();
  for (const r of cfg.repositories) {
    const slug = deriveRepoSlug(r.url);
    if (slugs.has(slug)) {
      throw new RepoSyncError(
        `Two registered repositories produce the same slug '${slug}'. Operator must rename one repository's URL.`,
      );
    }
    slugs.add(slug);
  }

  const entries: SyncedRegistryRepoEntry[] = [];
  for (const src of cfg.repositories) {
    const slug = deriveRepoSlug(src.url);
    if (opts.onlySlug && opts.onlySlug !== slug) {
      const carry = priorBySlug.get(slug);
      if (carry) entries.push(carry);
      else
        entries.push({
          url: src.url,
          default_branch: src.default_branch,
          slug,
          local_path: join(resolveReposDir(cfg), slug),
          last_synced_at: null,
          last_commit_sha: null,
          sync_status: 'pending',
          sync_error: null,
          frontmatter: null,
          narrative: null,
        });
      continue;
    }

    const { entry } = await processRepository(cfg, src, priorBySlug.get(slug), !!opts.quiet);
    entries.push(entry);
  }

  const finalEntries = applyNameCollisions(entries);

  const registry: SyncedRegistry = {
    synced_at: new Date().toISOString(),
    repositories: finalEntries,
  };

  await withLock(join(cfg.registry.base_folder, '.gaggle.lock'), 'gaggle sync', async () => {
    await writeSyncedRegistry(store, registry);
  });

  const ok = finalEntries.filter((e) => e.sync_status === 'ok').length;
  const errors = finalEntries.filter((e) => e.sync_status === 'error').length;
  const missing = finalEntries.filter((e) => e.sync_status === 'missing_gaggle_md').length;

  if (!opts.quiet) {
    logger.info('Sync pass complete', { ok, errors, missing, total: finalEntries.length });
  }

  return { registry, ok, errors, missing, per_repo: finalEntries };
}

/** Long-running periodic syncer. */
export interface SyncerHandle {
  stop: () => void;
  triggerNow: () => Promise<SyncResult | null>;
}

export function startPeriodicSyncer(cfg: ServiceConfig, store: Store): SyncerHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<SyncResult | null> | null = null;

  const trigger = async (): Promise<SyncResult | null> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        return await runSyncPass(cfg, { store, quiet: true });
      } catch (err) {
        logger.error('Periodic sync pass failed', { error: (err as Error).message });
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const schedule = () => {
    if (stopped) return;
    if (cfg.registry.sync_interval_ms <= 0) return;
    timer = setTimeout(async () => {
      await trigger();
      schedule();
    }, cfg.registry.sync_interval_ms);
  };

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    triggerNow: trigger,
  };
}
